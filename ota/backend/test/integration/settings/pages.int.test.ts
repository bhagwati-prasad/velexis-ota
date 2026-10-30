// The content pages through the API's whole pipeline (OBE-072; api-changes part 2 §2.4 and §4.1, OADR-0012 points 5 to
// 7), against PostgreSQL 16 and Redis 7: console.settings.pages.list, create, get, update and delete (the Markdown
// subset with the line of a refusal, the images of page_image assets, the supported locales, one page per slug and
// locale, If-Match and ETag, the Idempotency-Key, the legal links, the permissions, the staff_actions rows), and the
// public storefront.listPages and storefront.getPage for the edge and key callers (the published pages of the
// request's locale with the default locale's as fallback, blocks with each caller's image URLs, the cache per tenant,
// environment and locale and its deletion on every page and settings change).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha and beta active on test storefronts, a secret test key and a secret live key of alpha.
// Staff sign in through the OTA admin's service key with portal tokens, as storefront-settings.int.test.ts does, each
// admin client with an end-user IP address of its own. The settings rows are seeded as provisioning seeds them; alpha's
// storefront offers en (default), fr and de-CH, and gets a page image, a logo and a legal link to the slug
// `linked-terms`, written as the asset upload and the settings update write them. Each test uses slugs of its own, and
// the lists are read for those. Every JSON answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "viewer";
type Schema = "tenant_alpha" | "tenant_beta";
type Json = Record<string, unknown>;

const PAGES = "/v1/console/settings/pages";
const STOREFRONT_PAGES = "/v1/storefront/pages";
const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
/** PUBLIC_OTA_API_URL of this file's API: production's API host. */
const PUBLIC_API = "https://api.ota.example.com";
/** The slug alpha's legal link names. */
const LINKED_SLUG = "linked-terms";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let betaId: string;
let alphaSk: string;
let alphaLiveSk: string;
let owner: Staff;
let betaOwner: Staff;
let pageImageId: string;
let logoId: string;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one staff member. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** Inserts an active test tenant (a provisioned test schema for alpha and beta). */
async function insertTenant(key: string): Promise<string> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenantId,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/London",
      storefront_environment: "test",
    })
    .execute();
  return tenantId;
}

/** Inserts a secret key of `tenantId` in `environment`. */
async function insertSecretKey(tenantId: string, environment: "test" | "live"): Promise<string> {
  const key = newApiKey("sk", environment);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: `Server (${environment})`,
      kind: "secret",
      environment,
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

/** A staff member signed in through the OTA admin: the headers of its admin client, with the access token. */
interface Staff {
  readonly staffId: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Signs a new member with `role` in through a new admin client (its own end-user IP); fails unless it answers 200. */
async function signIn(tenantId: string, role: Role): Promise<Staff> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `staff.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/London",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  const portalToken = newPortalToken();
  const value = JSON.stringify({
    v: 1,
    accountId,
    tenantId,
    membershipId: staffId,
    role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(
    await redis.client.set(redisKeys.portalToken(sha256Hex(portalToken)).key, value, "EX", 60, "NX"),
  ).toBe("OK");
  const headers = {
    "X-Api-Key": testApiCredentials().serviceKey,
    "X-Velexis-End-User-IP": newIp(),
    "X-Velexis-End-User-Agent": `Mozilla/5.0 (OTA admin pages test ${randomBytes(3).toString("hex")})`,
    "X-Velexis-Environment": "test",
  };
  const res = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...headers, "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken });
  expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
  const accessToken = (res.body.session as { accessToken: string }).accessToken;
  return { staffId, headers: { ...headers, Authorization: `Bearer ${accessToken}` } };
}

/** An uploaded image of alpha, as the asset upload writes it (OBE-071). */
function assetRow(id: string, kind: string) {
  const hash = randomBytes(32).toString("hex");
  return {
    id,
    kind,
    content_type: "image/png",
    file_extension: "png",
    file_name: `${kind}.png`,
    size_bytes: 2048,
    width: 640,
    height: 320,
    storage_key: `tenant_alpha/assets/${hash}.png`,
    content_hash: hash,
  };
}

// ---- Calls ----------------------------------------------------------------------------------------------------------

/** console.settings.pages.create of `staff`, under a new or the given Idempotency-Key. */
const createPage = (staff: Staff, body: unknown, idempotencyKey: string = randomUUID()): request.Test =>
  request(api.server)
    .post(PAGES)
    .set(staff.headers)
    .set("Idempotency-Key", idempotencyKey)
    .send(body as object);

/** Creates a page as `staff`; fails unless it answers 201. Returns the page. */
async function created(staff: Staff, body: Json): Promise<Json> {
  const res = await createPage(staff, body);
  expect([res.status, res.body.error?.code]).toEqual([201, undefined]);
  expectResponseToMatch("consoleCreateStorefrontPage", res);
  return res.body as Json;
}

const getPage = (staff: Staff, id: unknown): request.Test =>
  request(api.server)
    .get(`${PAGES}/${String(id)}`)
    .set(staff.headers);

const patchPage = (staff: Staff, id: unknown, body: Json, ifMatch: string): request.Test =>
  request(api.server)
    .patch(`${PAGES}/${String(id)}`)
    .set(staff.headers)
    .set("If-Match", ifMatch)
    .send(body);

const deletePage = (staff: Staff, id: unknown, ifMatch: string): request.Test =>
  request(api.server)
    .delete(`${PAGES}/${String(id)}`)
    .set(staff.headers)
    .set("If-Match", ifMatch);

/** storefront.listPages through alpha's edge (or another host's) with these query and headers. */
const edgeList = (
  query = "",
  headers: Readonly<Record<string, string>> = {},
  host = ALPHA_HOST,
): request.Test => request(api.server).get(`${STOREFRONT_PAGES}${query}`).set(edgeHeaders(host)).set(headers);

/** storefront.getPage through alpha's edge. */
const edgePage = (slug: string, query = "", headers: Readonly<Record<string, string>> = {}): request.Test =>
  request(api.server).get(`${STOREFRONT_PAGES}/${slug}${query}`).set(edgeHeaders(ALPHA_HOST)).set(headers);

/** storefront.listPages and getPage with a secret key (alpha's test key by default). */
const keyList = (key = alphaSk, query = ""): request.Test =>
  request(api.server).get(`${STOREFRONT_PAGES}${query}`).set("X-Api-Key", key);
const keyPage = (slug: string, key = alphaSk, query = ""): request.Test =>
  request(api.server).get(`${STOREFRONT_PAGES}/${slug}${query}`).set("X-Api-Key", key);

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The `[status, error code, details]` of an answer. */
const refusal = (res: Response): [number, unknown, unknown] => [
  res.status,
  res.body?.error?.code,
  res.body?.error?.details,
];

/** The slugs of a storefront.listPages answer that start with `prefix`, in its order. */
const slugsOf = (res: Response, prefix: string): string[] =>
  (res.body.data as Json[]).map((page) => String(page["slug"])).filter((slug) => slug.startsWith(prefix));

/** The `storefront_pages` rows of `schema` whose slug starts with `prefix`. */
async function pageRows(schema: Schema, prefix: string): Promise<Json[]> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx
      .selectFrom("storefront_pages")
      .selectAll()
      .where("slug", "like", `${prefix}%`)
      .orderBy("slug")
      .orderBy("locale")
      .execute(),
  ) as Promise<Json[]>;
}

/** The staff_actions rows of `staffId` in `schema` about `targetId`, oldest first. */
async function staffActions(schema: Schema, staffId: string, targetId: unknown): Promise<Json[]> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .selectAll()
      .where("staff_id", "=", staffId)
      .where("target_id", "=", String(targetId))
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  ) as Promise<Json[]>;
}

/** Alpha's page caches in Redis, both environments. */
async function pageCaches(tenantId = alphaId): Promise<string[]> {
  return (await redis.client.keys(`t:${tenantId}:*:pages:*`)).sort();
}

/** A page of `locale` with these fields. */
const pageInput = (slug: string, fields: Json = {}): Json => ({
  slug,
  locale: "en",
  title: `Page ${slug}`,
  ...fields,
});

const text = (value: string) => ({ type: "text", text: value });

// Cloning the template and building the API's module graph (Nest, pools, Redis, the OTA document's validators) take
// several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget, and
// the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertTenant("alpha");
  betaId = await insertTenant("beta");
  alphaSk = await insertSecretKey(alphaId, "test");
  alphaLiveSk = await insertSecretKey(alphaId, "live");
  pageImageId = newId("ast");
  logoId = newId("ast");
  await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await trx
      .insertInto("storefront_assets")
      .values([assetRow(pageImageId, "page_image"), assetRow(logoId, "logo")])
      .execute();
    await trx
      .updateTable("storefront_settings")
      .set({
        supported_locales: ["en", "fr", "de-CH"],
        legal_links: JSON.stringify([{ kind: "terms", label: "Terms", pageSlug: LINKED_SLUG }]),
      })
      .where("id", "=", "sfs_default")
      .execute();
  });
  await tenantTx(tenantDb, "tenant_beta", (trx) =>
    seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "GBP", defaultLocale: "en-GB" }),
  );
  api = await createTestApp({ database: db, redis, env: { PUBLIC_OTA_API_URL: PUBLIC_API } });
  // The first sign-in, write and reads of a process open the pools' connections and warm the token, validation,
  // parser and response-check code; done once here, so that no test pays for it.
  owner = await signIn(alphaId, "owner");
  betaOwner = await signIn(betaId, "owner");
  const warmUp = await created(
    owner,
    pageInput("warm-up", { bodyMarkdown: "## Warm\n\n- up", isPublished: true }),
  );
  const list = await request(api.server).get(PAGES).set(owner.headers);
  expectResponseToMatch("consoleListStorefrontPages", list);
  const page = await edgePage("warm-up");
  expectResponseToMatch("getStorefrontPage", page);
  expectResponseToMatch("listStorefrontPages", await keyList());
  expect(await deletePage(owner, warmUp["id"], '"1"')).toMatchObject({ status: 204 });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

describe("console.settings.pages.create", () => {
  it("creates a page with its defaults, version 1, Location and ETag, and the staff_actions row", async () => {
    const res = await createPage(owner, pageInput("create-defaults", { title: "  About us  " }));

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleCreateStorefrontPage", res);
    const page = res.body as Json;
    expect(page).toEqual({
      id: expect.stringMatching(/^stp_[0-9A-Z]{26}$/),
      slug: "create-defaults",
      locale: "en",
      kind: "content",
      title: "About us",
      bodyMarkdown: "",
      isPublished: false,
      showInFooter: false,
      sortOrder: 100,
      publishedAt: null,
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["location"]).toBe(`${PAGES}/${String(page["id"])}`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(await pageRows("tenant_alpha", "create-defaults")).toEqual([
      expect.objectContaining({ id: page["id"], updated_by_staff_id: owner.staffId, version: 1 }),
    ]);
    expect(await staffActions("tenant_alpha", owner.staffId, page["id"])).toEqual([
      expect.objectContaining({
        action: "settings.pages.create",
        outcome: "succeeded",
        target_type: "storefront_page",
        before: null,
        after: expect.objectContaining({ slug: "create-defaults", title: "About us", version: 1 }),
      }),
    ]);
  });

  it("refuses <script>, raw HTML, tables and javascript: links with details.line, and saves nothing [OBE-072 AC1]", async () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["## Hello\n\nWelcome.\n<script>alert(1)</script>", 4],
      ['Intro\n\n<div onclick="x()">raw</div>', 3],
      ["## Fares\n\n| Fare | Bags |\n|------|------|\n| Light | 0 |", 3],
      ["One\n\nRead [this](javascript:alert(document.cookie))", 3],
    ];
    for (const [bodyMarkdown, line] of cases) {
      const res = await createPage(owner, pageInput("refused-markdown", { bodyMarkdown, isPublished: true }));

      expect([bodyMarkdown, refusal(res)]).toEqual([
        bodyMarkdown,
        [422, "UNPROCESSABLE", { reason: "markdown_not_allowed", line }],
      ]);
      expectResponseToMatch("consoleCreateStorefrontPage", res);
      expect(String(res.body.error.message)).toMatch(new RegExp(`^Line ${line} `));
    }
    expect(await pageRows("tenant_alpha", "refused-markdown")).toEqual([]);
  });

  it("refuses an image of an unknown asset or of another kind with its line, and a locale the storefront does not offer", async () => {
    const unknown = newId("ast");
    for (const [bodyMarkdown, reason, line] of [
      [`Intro\n\n![Team](${unknown})`, "asset_not_found", 3],
      [`![Logo](${logoId})`, "asset_kind", 1],
    ] as const) {
      const res = await createPage(owner, pageInput("refused-image", { bodyMarkdown }));

      expect(refusal(res)).toEqual([422, "UNPROCESSABLE", { reason, line }]);
      expectResponseToMatch("consoleCreateStorefrontPage", res);
    }
    const locale = await createPage(owner, pageInput("refused-locale", { locale: "it" }));
    expect(refusal(locale)).toEqual([422, "UNPROCESSABLE", { reason: "locale_not_supported" }]);
    // Blank titles and bodies over 50 000 characters never reach the table.
    const blank = await createPage(owner, pageInput("refused-title", { title: "   " }));
    expect([blank.status, blank.body.error.fieldErrors]).toEqual([
      400,
      [expect.objectContaining({ path: "/title", code: "minLength" })],
    ]);
    // A title with a control character (PostgreSQL would refuse its NUL with a 500).
    const control = await createPage(owner, pageInput("refused-control", { title: "Terms\u0000and more" }));
    expect([control.status, control.body.error.fieldErrors]).toEqual([
      400,
      [expect.objectContaining({ path: "/title", code: "pattern" })],
    ]);
    expectResponseToMatch("consoleCreateStorefrontPage", control);
    const long = await createPage(owner, pageInput("refused-long", { bodyMarkdown: "x".repeat(50_001) }));
    expect(answer(long)).toEqual([400, "VALIDATION_FAILED"]);
    expect(await pageRows("tenant_alpha", "refused-")).toEqual([]);
  });

  it("keeps one page per slug and locale (409 page_exists); another locale of the slug is its translation", async () => {
    await created(owner, pageInput("translated"));

    const again = await createPage(owner, pageInput("translated", { title: "Again" }));
    const french = await createPage(owner, pageInput("translated", { locale: "fr", title: "Traduit" }));

    expect(refusal(again)).toEqual([
      409,
      "CONFLICT",
      { reason: "page_exists", slug: "translated", locale: "en" },
    ]);
    expectResponseToMatch("consoleCreateStorefrontPage", again);
    expect(answer(french)).toEqual([201, undefined]);
    expect(
      (await pageRows("tenant_alpha", "translated")).map((row) => [row["locale"], row["title"]]),
    ).toEqual([
      ["en", "Page translated"],
      ["fr", "Traduit"],
    ]);
  });

  it("answers a retry with the same Idempotency-Key with the same page, and the key with another body 409", async () => {
    const key = randomUUID();
    const body = pageInput("idempotent", { kind: "faq" });

    const first = await createPage(owner, body, key);
    const retry = await createPage(owner, body, key);
    const other = await createPage(owner, { ...body, title: "Other" }, key);

    expect(answer(first)).toEqual([201, undefined]);
    expect([retry.status, retry.body]).toEqual([201, first.body]);
    expect(answer(other)).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    expect(await pageRows("tenant_alpha", "idempotent")).toHaveLength(1);
  });

  it("lets a viewer list and read the pages but not create one (403 FORBIDDEN, settings:write)", async () => {
    const viewer = await signIn(alphaId, "viewer");
    const page = await created(owner, pageInput("viewer-reads"));

    expect(answer(await request(api.server).get(PAGES).set(viewer.headers))).toEqual([200, undefined]);
    expect(answer(await getPage(viewer, page["id"]))).toEqual([200, undefined]);
    const denied = await createPage(viewer, pageInput("viewer-creates"));
    expect(refusal(denied)).toEqual([403, "FORBIDDEN", { requiredPermission: "settings:write" }]);
    expect(await pageRows("tenant_alpha", "viewer-creates")).toEqual([]);
  });
});

describe("console.settings.pages.list and get", () => {
  it("lists drafts and published pages by sortOrder, slug and locale, with the locale and published filters and a cursor", async () => {
    await created(owner, pageInput("order-b", { sortOrder: 5 }));
    await created(owner, pageInput("order-a", { sortOrder: 5, locale: "fr", isPublished: true }));
    await created(owner, pageInput("order-a", { sortOrder: 5, isPublished: true }));
    await created(owner, pageInput("order-c", { sortOrder: 1 }));

    const all = await request(api.server).get(PAGES).query({ limit: 100 }).set(owner.headers);
    expectResponseToMatch("consoleListStorefrontPages", all);
    const order = (all.body.data as Json[])
      .filter((page) => String(page["slug"]).startsWith("order-"))
      .map((page) => `${String(page["slug"])}/${String(page["locale"])}`);
    expect(order).toEqual(["order-c/en", "order-a/en", "order-a/fr", "order-b/en"]);

    const french = await request(api.server)
      .get(PAGES)
      .query({ locale: "fr", limit: 100 })
      .set(owner.headers);
    expect((french.body.data as Json[]).every((page) => page["locale"] === "fr")).toBe(true);
    const published = await request(api.server).get(PAGES).query({ published: true }).set(owner.headers);
    expect((published.body.data as Json[]).every((page) => page["isPublished"] === true)).toBe(true);

    // Page by page: the cursor continues the same list, and another list's cursor is refused.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Response = await request(api.server)
        .get(PAGES)
        .query({ limit: 2, ...(cursor === null ? {} : { cursor }) })
        .set(owner.headers);
      expect(answer(res)).toEqual([200, undefined]);
      seen.push(
        ...(res.body.data as Json[]).map((page) => `${String(page["slug"])}/${String(page["locale"])}`),
      );
      cursor = (res.body.page as { nextCursor: string | null }).nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(
      (all.body.data as Json[]).map((page) => `${String(page["slug"])}/${String(page["locale"])}`),
    );
    const first = await request(api.server).get(PAGES).query({ limit: 1 }).set(owner.headers);
    const foreign = await request(api.server)
      .get(PAGES)
      .query({ limit: 1, locale: "fr", cursor: (first.body.page as { nextCursor: string }).nextCursor })
      .set(owner.headers);
    expect([foreign.status, foreign.body.error.fieldErrors]).toEqual([
      400,
      [expect.objectContaining({ path: "/query/cursor" })],
    ]);
  });

  it("answers a page with its ETag, 404 for an unknown id and for another tenant's page", async () => {
    const page = await created(owner, pageInput("get-one", { bodyMarkdown: "Some *text*." }));

    const res = await getPage(owner, page["id"]);
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetStorefrontPage", res);
    expect(res.body).toEqual(page);
    expect([res.headers["etag"], res.headers["cache-control"]]).toEqual(['"1"', "private, no-store"]);
    expect(answer(await getPage(owner, newId("stp")))).toEqual([404, "NOT_FOUND"]);
    expect(answer(await getPage(betaOwner, page["id"]))).toEqual([404, "NOT_FOUND"]);
  });
});

describe("console.settings.pages.update and delete", () => {
  it("updates with If-Match, a quoted ETag included: 412 when stale, publishedAt set on the first publication and kept", async () => {
    const page = await created(owner, pageInput("update-me"));

    const stale = await patchPage(owner, page["id"], { title: "Stale" }, '"7"');
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consoleUpdateStorefrontPage", stale);

    const published = await patchPage(owner, page["id"], { isPublished: true, showInFooter: true }, '"1"');
    expect(answer(published)).toEqual([200, undefined]);
    expectResponseToMatch("consoleUpdateStorefrontPage", published);
    expect(published.body).toMatchObject({ isPublished: true, showInFooter: true, version: 2 });
    expect(published.headers["etag"]).toBe('"2"');
    const publishedAt = published.body.publishedAt as string;
    expect(Date.parse(publishedAt)).not.toBeNaN();

    const unpublished = await patchPage(owner, page["id"], { isPublished: false, kind: "faq" }, "2");
    expect(unpublished.body).toMatchObject({ isPublished: false, kind: "faq", publishedAt, version: 3 });
    const again = await patchPage(owner, page["id"], { isPublished: true }, 'W/"3"');
    expect(again.body).toMatchObject({ isPublished: true, publishedAt, version: 4 });

    // The refused update has the audit interceptor's failed row; each change its own row with before and after.
    const audit = await staffActions("tenant_alpha", owner.staffId, page["id"]);
    expect(audit.map((row) => [row["action"], row["outcome"]])).toEqual([
      ["settings.pages.create", "succeeded"],
      ["settings.pages.update", "failed"],
      ["settings.pages.update", "succeeded"],
      ["settings.pages.update", "succeeded"],
      ["settings.pages.update", "succeeded"],
    ]);
    expect(audit[2]).toMatchObject({
      before: expect.objectContaining({ isPublished: false, version: 1 }),
      after: expect.objectContaining({ isPublished: true, version: 2 }),
    });
  });

  it("checks an updated body as create does and keeps the stored one when it is refused", async () => {
    const page = await created(owner, pageInput("update-body", { bodyMarkdown: "Fine." }));

    const refused = await patchPage(owner, page["id"], { bodyMarkdown: "Fine.\n\n> quoted" }, '"1"');
    expect(refusal(refused)).toEqual([422, "UNPROCESSABLE", { reason: "markdown_not_allowed", line: 3 }]);
    expectResponseToMatch("consoleUpdateStorefrontPage", refused);
    const image = await patchPage(owner, page["id"], { bodyMarkdown: `![Team](${pageImageId})` }, '"1"');
    expect(answer(image)).toEqual([200, undefined]);
    expect(answer(await patchPage(owner, page["id"], { title: " " }, '"2"'))).toEqual([
      400,
      "VALIDATION_FAILED",
    ]);
    expect(await pageRows("tenant_alpha", "update-body")).toEqual([
      expect.objectContaining({ body_markdown: `![Team](${pageImageId})`, version: 2 }),
    ]);
  });

  it("deletes a page with If-Match; a page whose slug a legal link names cannot be deleted in any locale [OADR-0012 point 6]", async () => {
    const linked = await created(owner, pageInput(LINKED_SLUG, { kind: "terms" }));
    const linkedFr = await created(owner, pageInput(LINKED_SLUG, { kind: "terms", locale: "fr" }));
    const other = await created(owner, pageInput("delete-me"));

    for (const page of [linked, linkedFr]) {
      const res = await deletePage(owner, page["id"], '"1"');
      expect(refusal(res)).toEqual([409, "CONFLICT", { reason: "page_linked", slug: LINKED_SLUG }]);
      expectResponseToMatch("consoleDeleteStorefrontPage", res);
    }
    expect(answer(await deletePage(owner, other["id"], '"2"'))).toEqual([412, "PRECONDITION_FAILED"]);
    const deleted = await deletePage(owner, other["id"], '"1"');
    expect([deleted.status, deleted.headers["cache-control"]]).toEqual([204, "private, no-store"]);
    expect(answer(await getPage(owner, other["id"]))).toEqual([404, "NOT_FOUND"]);
    expect(await pageRows("tenant_alpha", LINKED_SLUG)).toHaveLength(2);
    const deletions = (await staffActions("tenant_alpha", owner.staffId, other["id"])).filter(
      (row) => row["action"] === "settings.pages.delete",
    );
    expect(deletions.map((row) => [row["outcome"], row["before"], row["after"]])).toEqual([
      ["failed", null, null],
      ["succeeded", expect.objectContaining({ slug: "delete-me" }), null],
    ]);
  });

  it("refuses to delete an image a page shows (409 asset_in_use with the page)", async () => {
    const imageId = newId("ast");
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.insertInto("storefront_assets").values(assetRow(imageId, "page_image")).execute(),
    );
    const page = await created(owner, pageInput("shows-image", { bodyMarkdown: `![Office](${imageId})` }));

    const res = await request(api.server).delete(`/v1/console/settings/assets/${imageId}`).set(owner.headers);

    expect(refusal(res)).toEqual([
      409,
      "CONFLICT",
      { reason: "asset_in_use", settingsPaths: [], pageIds: [page["id"]] },
    ]);
  });
});

describe("storefront.listPages and storefront.getPage", () => {
  it("[OBE-072 AC2] serves a published page in storefront.listPages within the cache window, and answers 404 for an unpublished one", async () => {
    // A list read fills the cache of the locale for at most 5 minutes.
    expect(answer(await edgeList())).toEqual([200, undefined]);
    const cache = redisKeys.pages(alphaId, "test", "en").key;
    const ttl = await redis.client.ttl(cache);
    expect(ttl > 0 && ttl <= 300).toBe(true);

    const published = await created(
      owner,
      pageInput("ac2-published", {
        kind: "about",
        title: "About Alpha",
        isPublished: true,
        showInFooter: true,
      }),
    );
    await created(owner, pageInput("ac2-draft", { title: "Draft" }));
    // The console's change deleted the cache: the next read sees the page.
    expect(await redis.client.exists(cache)).toBe(0);

    const list = await edgeList();
    expect(answer(list)).toEqual([200, undefined]);
    expectResponseToMatch("listStorefrontPages", list);
    expect((list.body.data as Json[]).filter((page) => String(page["slug"]).startsWith("ac2-"))).toEqual([
      { slug: "ac2-published", title: "About Alpha", kind: "about", showInFooter: true, sortOrder: 100 },
    ]);
    const page = await edgePage("ac2-published");
    expect(answer(page)).toEqual([200, undefined]);
    expectResponseToMatch("getStorefrontPage", page);
    const draft = await edgePage("ac2-draft");
    expect(answer(draft)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("getStorefrontPage", draft);

    // Unpublishing takes it off at once.
    expect(answer(await patchPage(owner, published["id"], { isPublished: false }, '"1"'))).toEqual([
      200,
      undefined,
    ]);
    expect(answer(await edgePage("ac2-published"))).toEqual([404, "NOT_FOUND"]);
    expect(slugsOf(await edgeList(), "ac2-")).toEqual([]);

    // A page published without the console (no deletion) waits for the cache window: the cached list stands until
    // the hash expires (deleted here as its expiry would).
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .insertInto("storefront_pages")
        .values({
          id: newId("stp"),
          slug: "ac2-direct",
          locale: "en",
          title: "Direct",
          is_published: true,
          published_at: new Date(),
        })
        .execute(),
    );
    expect(slugsOf(await edgeList(), "ac2-")).toEqual([]);
    await redis.client.del(cache);
    expect(slugsOf(await edgeList(), "ac2-")).toEqual(["ac2-direct"]);
  });

  it("parses the body into blocks, with the image URL of each caller and their Cache-Control", async () => {
    const body = [
      "## Who we are",
      "",
      "Alpha sells **flights**. Write to [us](mailto:help@alpha.example) or read the [terms](/p/linked-terms).",
      "",
      "1. Open your booking.",
      "2. Choose *Cancel*.",
      "",
      `![Our team](${pageImageId})`,
    ].join("\n");
    await created(owner, pageInput("blocks", { title: "Blocks", bodyMarkdown: body, isPublished: true }));

    const edge = await edgePage("blocks");
    const key = await keyPage("blocks");

    expect(answer(edge)).toEqual([200, undefined]);
    expectResponseToMatch("getStorefrontPage", edge);
    expectResponseToMatch("getStorefrontPage", key);
    const image = {
      type: "image",
      assetId: pageImageId,
      url: `/api/v1/assets/alpha/${pageImageId}.png`,
      alt: "Our team",
      width: 640,
      height: 320,
    };
    expect(edge.body).toEqual({
      slug: "blocks",
      locale: "en",
      title: "Blocks",
      kind: "content",
      blocks: [
        { type: "heading", level: 2, content: [text("Who we are")] },
        {
          type: "paragraph",
          content: [
            text("Alpha sells "),
            { type: "strong", content: [text("flights")] },
            text(". Write to "),
            { type: "link", href: "mailto:help@alpha.example", content: [text("us")] },
            text(" or read the "),
            { type: "link", href: "/p/linked-terms", content: [text("terms")] },
            text("."),
          ],
        },
        {
          type: "list",
          ordered: true,
          start: 1,
          items: [
            { content: [text("Open your booking.")] },
            { content: [text("Choose "), { type: "em", content: [text("Cancel")] }, text(".")] },
          ],
        },
        image,
      ],
      updatedAt: expect.any(String),
    });
    // Key callers get the API host's absolute URL; the rest is the same page.
    expect(key.body).toEqual({
      ...edge.body,
      blocks: [
        ...(edge.body.blocks as Json[]).slice(0, 3),
        { ...image, url: `${PUBLIC_API}/v1/assets/alpha/${pageImageId}.png` },
      ],
    });
    expect([edge.headers["cache-control"], edge.headers["vary"]]).toEqual(["private", "Accept-Language"]);
    expect(key.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=600");
    expect(String(key.headers["vary"])).toContain("X-Api-Key");
    // A refused read is never kept.
    expect((await keyPage("no-such-page")).headers["cache-control"]).toBe("no-store");
  });

  it("serves the request's locale with the default locale's page as fallback: the locale parameter, then Accept-Language", async () => {
    await created(owner, pageInput("lang-both", { title: "Both (en)", isPublished: true, sortOrder: 1 }));
    await created(
      owner,
      pageInput("lang-both", { title: "Les deux (fr)", locale: "fr", isPublished: true, sortOrder: 1 }),
    );
    await created(owner, pageInput("lang-en", { title: "English only", isPublished: true, sortOrder: 2 }));
    await created(owner, pageInput("lang-fr", { title: "Brouillon", locale: "fr", sortOrder: 3 }));
    await created(
      owner,
      pageInput("lang-swiss", { title: "Nur Schweiz", locale: "de-CH", isPublished: true }),
    );

    const titles = (res: Response): string[] =>
      (res.body.data as Json[])
        .filter((page) => String(page["slug"]).startsWith("lang-"))
        .map((page) => `${String(page["slug"])}: ${String(page["title"])}`);
    const french = await edgeList("?locale=fr");
    expectResponseToMatch("listStorefrontPages", french);
    expect(titles(french)).toEqual(["lang-both: Les deux (fr)", "lang-en: English only"]);
    expect(titles(await edgeList("", { "Accept-Language": "fr-CA,fr;q=0.9" }))).toEqual(titles(french));
    expect(titles(await edgeList("", { "Accept-Language": "de-CH" }))).toEqual([
      "lang-both: Both (en)",
      "lang-en: English only",
      "lang-swiss: Nur Schweiz",
    ]);
    // A locale the storefront does not offer counts as absent: Accept-Language, then the default locale.
    expect(titles(await edgeList("?locale=it", { "Accept-Language": "fr" }))).toEqual(titles(french));
    expect(titles(await edgeList("?locale=it"))).toEqual(["lang-both: Both (en)", "lang-en: English only"]);

    const fallback = await edgePage("lang-en", "?locale=fr");
    expectResponseToMatch("getStorefrontPage", fallback);
    expect([fallback.body.locale, fallback.body.title]).toEqual(["en", "English only"]);
    expect((await edgePage("lang-both", "", { "Accept-Language": "fr" })).body.locale).toBe("fr");
    expect(answer(await edgePage("lang-fr", "?locale=fr"))).toEqual([404, "NOT_FOUND"]);
    expect(answer(await edgePage("lang-swiss"))).toEqual([404, "NOT_FOUND"]);
  });

  it("caches per tenant, environment and locale, and every page or settings change deletes the hashes of both environments", async () => {
    await created(owner, pageInput("cached", { isPublished: true }));
    await edgeList();
    await edgePage("cached");
    await keyList(alphaLiveSk, "?locale=fr");
    const test = redisKeys.pages(alphaId, "test", "en").key;
    const liveFr = redisKeys.pages(alphaId, "live", "fr").key;

    expect(await pageCaches()).toEqual([liveFr, test].sort());
    expect((await redis.client.hkeys(test)).sort()).toEqual(["list", "page:cached"]);
    // A slug without a published page answers 404 from the cached list and never gets a field of its own.
    expect(answer(await edgePage("cached-missing"))).toEqual([404, "NOT_FOUND"]);
    expect((await redis.client.hkeys(test)).sort()).toEqual(["list", "page:cached"]);
    // Another tenant has its own (empty) list.
    const beta = await edgeList("", {}, BETA_HOST);
    expect([beta.status, beta.body]).toEqual([200, { data: [] }]);
    expect(await pageCaches(betaId)).toEqual([redisKeys.pages(betaId, "test", "en-GB").key]);

    // A page change deletes alpha's hashes of every locale in both environments.
    await created(owner, pageInput("cached-draft"));
    expect(await pageCaches()).toEqual([]);

    // So does a change of the storefront settings (the locales decide which page a locale serves).
    await edgeList();
    await keyList(alphaLiveSk);
    expect(await pageCaches()).toHaveLength(2);
    const settings = await request(api.server).get("/v1/console/settings/storefront").set(owner.headers);
    const update = await request(api.server)
      .patch("/v1/console/settings/storefront")
      .set(owner.headers)
      .set("If-Match", String(settings.headers["etag"]))
      .send({ airlineCard: settings.body.airlineCard });
    expect(answer(update)).toEqual([200, undefined]);
    expect(await pageCaches()).toEqual([]);
    expect(await pageCaches(betaId)).toHaveLength(1);
  });
});
