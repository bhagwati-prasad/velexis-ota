// The storefront assets through the API's whole pipeline (OBE-071; api-changes part 2 §2.5 and §4.2, OADR-0012 points
// 2 and 3), against PostgreSQL 16 and Redis 7: console.settings.assets.upload (the multipart body parsed on its route
// only, the type sniffed from the bytes, the size and dimension limits, the storage key of the file's SHA-256, the
// same file again, the Idempotency-Key over the parts, the staff_actions row), list and delete (in use by the settings
// or a page), and the public image URL getPublicAsset (its headers, the OTA of the path whatever the credential, a
// suspended OTA's images, 404 for everything unknown, the rate limit), with storefront.get's URLs of both callers.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform
// rows as the platform does: alpha and beta active on test storefronts, a gamma being deprovisioned, a secret test key
// of each of alpha and beta. Staff sign in through the OTA admin's service key with portal tokens, as
// storefront-settings.int.test.ts does, each admin client with an end-user IP address of its own. The settings rows
// are seeded as provisioning seeds them. The API stores files in a folder of its own (STORAGE_DIR), and its public
// API host is production's (PUBLIC_OTA_API_URL). The images are built by test/builders/images.ts. Every JSON answer is
// checked against the OTA document.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { trackerDigest } from "../../../src/common/http/rate-limits";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { ASSET_MAX_BYTES } from "../../../src/settings/assets.service";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { buildIco, buildJpeg, buildPng, buildWebp, CSS_FILE, SVG_IMAGE } from "../../builders/images";
import { edgeHeaders, newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "viewer";
type Schema = "tenant_alpha" | "tenant_beta";
type Json = Record<string, unknown>;

const ASSETS = "/v1/console/settings/assets";
const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
/** PUBLIC_OTA_API_URL of this file's API: production's API host. */
const PUBLIC_API = "https://api.ota.example.com";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let storageDir: string;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let betaId: string;
let alphaSk: string;
let betaSk: string;
let alphaOwner: Staff;
let betaOwner: Staff;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one staff member. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

let visitorCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one visitor of the public images. */
const newVisitorIp = (): string => {
  visitorCounter += 1;
  return `203.0.113.${visitorCounter}`;
};

/** The first bytes of a PNG: a large body that starts like an image. */
const PNG_HEADER = buildPng({ width: 1, height: 1 }).subarray(0, 33);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** Inserts a test tenant (a provisioned test schema for alpha and beta). */
async function insertTenant(key: string, status = "active"): Promise<string> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenantId,
      key,
      name: `${key} Travel`,
      status,
      plan_code: "early_access",
      time_zone: "Europe/London",
      storefront_environment: "test",
    })
    .execute();
  return tenantId;
}

/** Inserts a secret test key of `tenantId` with these scopes (none: customer scope). */
async function insertSecretKey(tenantId: string, scopes: readonly string[] = []): Promise<string> {
  const key = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(scopes.length === 0 ? {} : { scopes: [...scopes] }),
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
    "X-Velexis-End-User-Agent": `Mozilla/5.0 (OTA admin assets test ${randomBytes(3).toString("hex")})`,
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

/** One part of an upload: a text part, or a file part with its file name and declared type. */
type Part =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly file: Buffer;
      readonly fileName: string;
      readonly contentType?: string;
    };

/** console.settings.assets.upload of `staff` with these parts, under a new or the given Idempotency-Key. */
function upload(staff: Staff, parts: readonly Part[], idempotencyKey: string = randomUUID()): request.Test {
  let req = request(api.server).post(ASSETS).set(staff.headers).set("Idempotency-Key", idempotencyKey);
  for (const part of parts) {
    req =
      "file" in part
        ? req.attach(part.name, part.file, {
            filename: part.fileName,
            contentType: part.contentType ?? "application/octet-stream",
          })
        : req.field(part.name, part.value);
  }
  return req;
}

/** The parts of an image of `kind` named `fileName`. */
const imageParts = (kind: string, file: Buffer, fileName = `${kind}.png`, contentType?: string): Part[] => [
  { name: "kind", value: kind },
  { name: "file", file, fileName, ...(contentType === undefined ? {} : { contentType }) },
];

/** Uploads an image of `kind` as `staff`; fails unless it answers 201. Returns the asset. */
async function uploaded(staff: Staff, kind: string, file: Buffer, fileName?: string): Promise<Json> {
  const res = await upload(staff, imageParts(kind, file, fileName));
  expect([res.status, res.body.error?.code]).toEqual([201, undefined]);
  return res.body as Json;
}

let pngCounter = 0;
/**
 * A PNG no other upload of this file sends: each call pads its file to a size of its own (the other images of the file
 * are smaller or of other dimensions), so its bytes (and storage key) are its own, never by chance another call's.
 */
const uniquePng = (width = 64, height = 32): Buffer => {
  pngCounter += 1;
  return buildPng({ width, height, shade: randomInt(256), sizeBytes: 2048 + pngCounter });
};

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The `[status, error code, details.reason]` of an answer. */
const refusal = (res: Response): [number, unknown, unknown] => [
  res.status,
  res.body?.error?.code,
  res.body?.error?.details?.reason,
];

/** The `storefront_assets` rows of `schema`. */
async function assetRows(schema: Schema): Promise<Json[]> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx.selectFrom("storefront_assets").selectAll().orderBy("created_at").orderBy("id").execute(),
  ) as Promise<Json[]>;
}

/** The staff_actions rows of `staffId` in `schema`, oldest first. */
async function staffActions(schema: Schema, staffId: string): Promise<Json[]> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .selectAll()
      .where("staff_id", "=", staffId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  ) as Promise<Json[]>;
}

/** The stored file of a storage key, or `undefined`. */
const storedFile = (storageKey: string): Buffer | undefined => {
  const path = join(storageDir, storageKey);
  return existsSync(path) ? readFileSync(path) : undefined;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The public path of an asset URL (`https://api.ota.example.com/v1/assets/…` → `/v1/assets/…`). */
const pathOf = (url: unknown): string => new URL(String(url)).pathname;

/** getPublicAsset without a credential, from a visitor IP of its own (its rate limit counts per IP). */
const publicGet = (path: string, ip = newVisitorIp()) =>
  request(api.server).get(path).set("X-Forwarded-For", ip);

/** Settings of alpha that reference `logoId` as its logo, written as console.settings.storefront.update does. */
async function useAsLogo(schema: Schema, logoId: string | null): Promise<void> {
  await tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx
      .updateTable("storefront_settings")
      .set({ logo_asset_id: logoId })
      .where("id", "=", "sfs_default")
      .execute(),
  );
}

// Cloning the template and building the API's module graph (Nest, pools, Redis, the OTA document's validators) take
// several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget, and
// the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-assets-"));
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
  await insertTenant("gamma", "deprovisioning");
  alphaSk = await insertSecretKey(alphaId);
  betaSk = await insertSecretKey(betaId);
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );
  await tenantTx(tenantDb, "tenant_beta", (trx) =>
    seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "GBP", defaultLocale: "en-GB" }),
  );
  api = await createTestApp({
    database: db,
    redis,
    env: { STORAGE_DIR: storageDir, PUBLIC_OTA_API_URL: PUBLIC_API },
  });
  // The first sign-in, upload and read of a process open the pools' connections and warm the token, validation and
  // multipart code; done once here, so that no test pays for it.
  alphaOwner = await signIn(alphaId, "owner");
  betaOwner = await signIn(betaId, "owner");
  const warmUp = await upload(alphaOwner, imageParts("page_image", uniquePng()));
  expect(warmUp.status).toBe(201);
  expect((await publicGet(pathOf(warmUp.body.url))).status).toBe(200);
  const list = await request(api.server).get(ASSETS).set(betaOwner.headers);
  expect(list.status).toBe(200);
  // The response checker compiles the document's response schemas on its first use.
  expectResponseToMatch("consoleUploadStorefrontAsset", warmUp);
  expectResponseToMatch("consoleListStorefrontAssets", list);
  // The test's own pool too.
  expect(await assetRows("tenant_alpha")).toHaveLength(1);
  await staffActions("tenant_alpha", alphaOwner.staffId);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  if (storageDir !== undefined) {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

describe("console.settings.assets.upload", () => {
  it("stores a PNG logo under the tenant's assets/<sha256>.png and answers the asset with its public URL", async () => {
    const png = buildPng({ width: 640, height: 160, shade: 0x11 });

    const res = await upload(alphaOwner, imageParts("logo", png, "C:\\fakepath\\Acme logo.png", "image/png"));

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleUploadStorefrontAsset", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const asset = res.body as Json;
    expect(asset).toEqual({
      id: expect.stringMatching(/^ast_[0-9A-Z]{26}$/),
      kind: "logo",
      contentType: "image/png",
      sizeBytes: png.length,
      width: 640,
      height: 160,
      fileName: "Acme logo.png",
      url: `${PUBLIC_API}/v1/assets/alpha/${String(asset["id"])}.png`,
      createdAt: expect.any(String),
    });
    const storageKey = `tenant_alpha/assets/${sha256(png)}.png`;
    expect(storedFile(storageKey)?.equals(png)).toBe(true);
    const row = (await assetRows("tenant_alpha")).find((entry) => entry["id"] === asset["id"]);
    expect(row).toMatchObject({
      storage_key: storageKey,
      content_hash: sha256(png),
      uploaded_by_staff_id: alphaOwner.staffId,
    });
    // The audit has the metadata, never the file.
    const audit = (await staffActions("tenant_alpha", alphaOwner.staffId)).filter(
      (entry) => entry["target_id"] === asset["id"],
    );
    expect(audit).toEqual([
      expect.objectContaining({
        action: "settings.assets.upload",
        outcome: "succeeded",
        target_type: "storefront_asset",
        before: null,
        after: expect.objectContaining({ kind: "logo", sizeBytes: png.length, contentHash: sha256(png) }),
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(png.subarray(16, 40).toString("base64"));
  });

  it("refuses an SVG renamed to .png and declared image/png, and a stylesheet: the type is read from the bytes [OBE-071 AC1]", async () => {
    const before = (await assetRows("tenant_alpha")).length;
    for (const [file, fileName] of [
      [Buffer.from(SVG_IMAGE), "logo.png"],
      [Buffer.from(CSS_FILE), "theme.png"],
    ] as const) {
      const res = await upload(alphaOwner, imageParts("logo", file, fileName, "image/png"));

      expect(refusal(res)).toEqual([422, "ASSET_INVALID", "type"]);
      expectResponseToMatch("consoleUploadStorefrontAsset", res);
      expect(storedFile(`tenant_alpha/assets/${sha256(file)}.png`)).toBeUndefined();
    }
    expect(await assetRows("tenant_alpha")).toHaveLength(before);
  });

  it("answers a 1.2 MB PNG 422 size, as a file just above 1 MB, and takes a file of exactly 1 MB [OBE-071 AC1]", async () => {
    const big = buildPng({ width: 100, height: 100, sizeBytes: 1_200_000 });
    const justAbove = buildPng({ width: 100, height: 100, sizeBytes: ASSET_MAX_BYTES + 1 });
    const exact = buildPng({ width: 100, height: 100, sizeBytes: ASSET_MAX_BYTES, shade: randomInt(256) });

    for (const file of [big, justAbove]) {
      const res = await upload(alphaOwner, imageParts("page_image", file));
      expect(refusal(res)).toEqual([422, "ASSET_INVALID", "size"]);
      expectResponseToMatch("consoleUploadStorefrontAsset", res);
    }
    const accepted = await upload(alphaOwner, imageParts("page_image", exact));
    expect(answer(accepted)).toEqual([201, undefined]);
    expect(accepted.body).toMatchObject({ sizeBytes: ASSET_MAX_BYTES });
  });

  it("answers a body far above the limit 422 size without reading it", async () => {
    const huge = Buffer.alloc(3 * 1024 * 1024, 0x2e);
    PNG_HEADER.copy(huge);

    const res = await upload(alphaOwner, imageParts("og_image", huge));

    expect(refusal(res)).toEqual([422, "ASSET_INVALID", "size"]);
  });

  it("takes JPEG, WebP and, for a favicon only, ICO; limits logos to 2000 × 2000 and nothing else", async () => {
    const jpeg = buildJpeg({ width: 1200, height: 630 });
    const webp = buildWebp("VP8L", 512, 512);
    const icon = buildIco([
      { width: 32, height: 32 },
      { width: 256, height: 256 },
    ]);
    const wideLogo = buildPng({ width: 2001, height: 100 });
    const square = buildPng({ width: 2000, height: 2000, shade: randomInt(256) });

    const og = await upload(alphaOwner, imageParts("og_image", jpeg, "share.jpg"));
    expect([answer(og), og.body.contentType, og.body.width, og.body.height]).toEqual([
      [201, undefined],
      "image/jpeg",
      1200,
      630,
    ]);
    expect(String(og.body.url)).toMatch(/\.jpg$/);
    const dark = await upload(alphaOwner, imageParts("logo_dark", webp, "dark.webp"));
    expect([answer(dark), dark.body.contentType]).toEqual([[201, undefined], "image/webp"]);
    const favicon = await upload(alphaOwner, imageParts("favicon", icon, "favicon.ico"));
    expect([answer(favicon), favicon.body.contentType, favicon.body.width]).toEqual([
      [201, undefined],
      "image/x-icon",
      256,
    ]);
    expect(refusal(await upload(alphaOwner, imageParts("logo_square", icon, "icon.ico")))).toEqual([
      422,
      "ASSET_INVALID",
      "type",
    ]);
    const tooWide = await upload(alphaOwner, imageParts("logo", wideLogo));
    expect(refusal(tooWide)).toEqual([422, "ASSET_INVALID", "dimensions"]);
    expectResponseToMatch("consoleUploadStorefrontAsset", tooWide);
    expect(answer(await upload(alphaOwner, imageParts("logo_square", square)))).toEqual([201, undefined]);
    // A page image may be larger than a logo.
    expect(answer(await upload(alphaOwner, imageParts("page_image", wideLogo)))).toEqual([201, undefined]);
  });

  it("answers missing, empty, repeated and unknown parts 400 VALIDATION_FAILED at their pointers", async () => {
    const png = uniquePng();
    const cases: ReadonlyArray<readonly [readonly Part[], ReadonlyArray<readonly [string, string]>]> = [
      [[{ name: "file", file: png, fileName: "a.png" }], [["/kind", "required"]]],
      [[{ name: "kind", value: "logo" }], [["/file", "required"]]],
      [imageParts("banner", png), [["/kind", "enum"]]],
      [
        [
          { name: "kind", value: "logo" },
          { name: "file", value: "not a file" },
        ],
        [["/file", "type"]],
      ],
      [imageParts("logo", Buffer.alloc(0)), [["/file", "minLength"]]],
      [[...imageParts("logo", png), { name: "kind", value: "favicon" }], [["/kind", "duplicate"]]],
      [[...imageParts("logo", png), { name: "colour", value: "red" }], [["/colour", "additionalProperties"]]],
      [[...imageParts("logo", png), { name: "fileName", value: " \u0007 " }], [["/fileName", "minLength"]]],
      [
        [...imageParts("logo", png), { name: "fileName", value: "x".repeat(201) }],
        [["/fileName", "maxLength"]],
      ],
    ];
    for (const [parts, expected] of cases) {
      const res = await upload(alphaOwner, parts);

      expect([
        answer(res),
        res.body.error?.fieldErrors?.map((error: Json) => [error["path"], error["code"]]),
      ]).toEqual([[400, "VALIDATION_FAILED"], expected]);
      expectResponseToMatch("consoleUploadStorefrontAsset", res);
    }
  });

  it("answers a body that is no multipart body, or not a well-formed one, 400 INVALID_REQUEST", async () => {
    const json = await request(api.server)
      .post(ASSETS)
      .set(alphaOwner.headers)
      .set("Idempotency-Key", randomUUID())
      .send({ kind: "logo", file: "iVBORw0KGgo=" });
    expect(refusal(json)).toEqual([400, "INVALID_REQUEST", "unsupported_media_type"]);
    expectResponseToMatch("consoleUploadStorefrontAsset", json);

    const broken = await request(api.server)
      .post(ASSETS)
      .set(alphaOwner.headers)
      .set("Idempotency-Key", randomUUID())
      .set("Content-Type", "multipart/form-data; boundary=velexis")
      .send('--velexis\r\nContent-Disposition: form-data; name="kind"\r\n\r\nlogo');
    expect(refusal(broken)).toEqual([400, "INVALID_REQUEST", "malformed_multipart"]);
  });

  it("keeps an explicit fileName, and names a file without one after its kind", async () => {
    const named = await upload(alphaOwner, [
      ...imageParts("page_image", uniquePng(), "IMG_0042.PNG"),
      { name: "fileName", value: "Our team" },
    ]);
    expect([answer(named), named.body.fileName]).toEqual([[201, undefined], "Our team"]);
    const unnamed = await upload(
      alphaOwner,
      imageParts("og_image", buildJpeg({ width: 9, height: 7 }), " \t "),
    );
    expect([answer(unnamed), unnamed.body.fileName]).toEqual([[201, undefined], "og_image.jpg"]);
  });

  it("answers the same file again for the same kind with its asset, and refuses it for another kind 409 asset_exists", async () => {
    const png = uniquePng();
    const first = await uploaded(alphaOwner, "page_image", png, "first.png");

    const again = await upload(alphaOwner, imageParts("page_image", png, "second.png"));
    expect(answer(again)).toEqual([201, undefined]);
    expect(again.body).toEqual(first);
    const other = await upload(alphaOwner, imageParts("og_image", png));
    expect(refusal(other)).toEqual([409, "CONFLICT", "asset_exists"]);
    expect(other.body.error.details).toEqual({
      reason: "asset_exists",
      assetId: first["id"],
      kind: "page_image",
    });
    expectResponseToMatch("consoleUploadStorefrontAsset", other);
    expect(
      (await assetRows("tenant_alpha")).filter((row) => row["content_hash"] === sha256(png)),
    ).toHaveLength(1);
  });

  it("replays an upload for the same key and parts, and refuses the same key with another file", async () => {
    const key = randomUUID();
    const parts = imageParts("page_image", uniquePng());

    const first = await upload(alphaOwner, parts, key);
    const replay = await upload(alphaOwner, parts, key);
    const otherFile = await upload(alphaOwner, imageParts("page_image", uniquePng()), key);
    const missingKey = await request(api.server)
      .post(ASSETS)
      .set(alphaOwner.headers)
      .field("kind", "page_image")
      .attach("file", uniquePng(), { filename: "a.png", contentType: "image/png" });

    expect(answer(first)).toEqual([201, undefined]);
    expect([answer(replay), replay.body]).toEqual([[201, undefined], first.body]);
    expect(answer(otherFile)).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    expect([answer(missingKey), missingKey.body.error.fieldErrors?.[0]?.path]).toEqual([
      [400, "VALIDATION_FAILED"],
      "/header/Idempotency-Key",
    ]);
  });

  it("refuses an agent, whose role has settings:read only, 403 FORBIDDEN", async () => {
    const agent = await signIn(alphaId, "agent");

    const res = await upload(agent, imageParts("logo", uniquePng()));

    expect(answer(res)).toEqual([403, "FORBIDDEN"]);
    expect(answer(await request(api.server).get(ASSETS).set(agent.headers))).toEqual([200, undefined]);
  });
});

describe("console.settings.assets.list", () => {
  it("lists an OTA's own images newest first, by kind, a page at a time", async () => {
    const viewer = await signIn(betaId, "viewer");
    const one = await uploaded(betaOwner, "page_image", uniquePng());
    const two = await uploaded(betaOwner, "logo", uniquePng());
    const three = await uploaded(betaOwner, "page_image", uniquePng());
    const list = (query: Record<string, string | number>) =>
      request(api.server).get(ASSETS).query(query).set(viewer.headers);

    const all = await list({});
    expect(answer(all)).toEqual([200, undefined]);
    expectResponseToMatch("consoleListStorefrontAssets", all);
    expect(all.headers["cache-control"]).toBe("private, no-store");
    const ids = (all.body.data as Json[]).map((asset) => asset["id"]);
    expect(ids.slice(0, 3)).toEqual([three["id"], two["id"], one["id"]]);
    // Alpha's images are not beta's.
    expect(
      (all.body.data as Json[]).every((asset) => String(asset["url"]).includes("/v1/assets/beta/")),
    ).toBe(true);

    const first = await list({ kind: "page_image", limit: 1 });
    expect([first.body.data.map((asset: Json) => asset["id"]), typeof first.body.page.nextCursor]).toEqual([
      [three["id"]],
      "string",
    ]);
    const second = await list({ kind: "page_image", limit: 1, cursor: first.body.page.nextCursor });
    expect(second.body.data.map((asset: Json) => asset["id"])).toEqual([one["id"]]);
    const wrongList = await list({ kind: "logo", cursor: first.body.page.nextCursor });
    expect([answer(wrongList), wrongList.body.error.fieldErrors?.[0]?.path]).toEqual([
      [400, "VALIDATION_FAILED"],
      "/query/cursor",
    ]);
  });
});

describe("console.settings.assets.delete", () => {
  it("answers 409 asset_in_use for a logo the settings use, and deletes it once they no longer do [OBE-071 AC3]", async () => {
    const logo = await uploaded(alphaOwner, "logo", uniquePng());
    await useAsLogo("tenant_alpha", String(logo["id"]));

    const inUse = await request(api.server)
      .delete(`${ASSETS}/${String(logo["id"])}`)
      .set(alphaOwner.headers);

    expect(refusal(inUse)).toEqual([409, "CONFLICT", "asset_in_use"]);
    expectResponseToMatch("consoleDeleteStorefrontAsset", inUse);
    expect(inUse.body.error.details).toEqual({
      reason: "asset_in_use",
      settingsPaths: ["/branding/logoAssetId"],
      pageIds: [],
    });
    expect((await publicGet(pathOf(logo["url"]))).status).toBe(200);

    await useAsLogo("tenant_alpha", null);
    const deleted = await request(api.server)
      .delete(`${ASSETS}/${String(logo["id"])}`)
      .set(alphaOwner.headers);
    expect([deleted.status, deleted.headers["cache-control"]]).toEqual([204, "private, no-store"]);
    expect((await assetRows("tenant_alpha")).some((row) => row["id"] === logo["id"])).toBe(false);
    expect((await publicGet(pathOf(logo["url"]))).status).toBe(404);
    expect(
      (await staffActions("tenant_alpha", alphaOwner.staffId)).filter(
        (entry) => entry["target_id"] === logo["id"] && entry["action"] === "settings.assets.delete",
      ),
    ).toEqual([
      expect.objectContaining({ outcome: "failed" }),
      expect.objectContaining({
        outcome: "succeeded",
        before: expect.objectContaining({ id: logo["id"], kind: "logo" }),
        after: null,
      }),
    ]);
  });

  it("answers 409 for an image a content page shows, 404 for an unknown or another OTA's image, and removes the file", async () => {
    const image = await uploaded(alphaOwner, "page_image", uniquePng());
    const pageId = newId("stp");
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .insertInto("storefront_pages")
        .values({
          id: pageId,
          slug: `about-${randomBytes(3).toString("hex")}`,
          locale: "en",
          kind: "about",
          title: "About us",
          body_markdown: `## Our team\n\n![The team](${String(image["id"])})\n`,
        })
        .execute(),
    );
    const remove = (staff: Staff, id: unknown) =>
      request(api.server)
        .delete(`${ASSETS}/${String(id)}`)
        .set(staff.headers);

    const shown = await remove(alphaOwner, image["id"]);
    expect([refusal(shown), shown.body.error.details.pageIds]).toEqual([
      [409, "CONFLICT", "asset_in_use"],
      [pageId],
    ]);
    expect(answer(await remove(betaOwner, image["id"]))).toEqual([404, "NOT_FOUND"]);
    expect(answer(await remove(alphaOwner, newId("ast")))).toEqual([404, "NOT_FOUND"]);

    const png = uniquePng();
    const unused = await uploaded(alphaOwner, "og_image", png);
    const storageKey = `tenant_alpha/assets/${sha256(png)}.png`;
    expect(storedFile(storageKey)?.equals(png)).toBe(true);
    expect((await remove(alphaOwner, unused["id"])).status).toBe(204);
    expect(storedFile(storageKey)).toBeUndefined();
  });
});

describe("getPublicAsset", () => {
  it("serves the image without a credential with the immutable cache, nosniff and CSP headers [OBE-071 AC2]", async () => {
    const png = uniquePng(120, 40);
    const asset = await uploaded(alphaOwner, "logo", png);

    const res = await publicGet(pathOf(asset["url"])).buffer(true);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).equals(png)).toBe(true);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(png.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "content-disposition": "inline",
      "cross-origin-resource-policy": "cross-origin",
    });
  });

  it("answers an unknown asset, another extension, another OTA's path and an unknown OTA 404 [OBE-071 AC2]", async () => {
    const asset = await uploaded(alphaOwner, "page_image", uniquePng());
    const id = String(asset["id"]);

    for (const path of [
      `/v1/assets/alpha/${newId("ast")}.png`,
      `/v1/assets/alpha/${id}.jpg`,
      `/v1/assets/beta/${id}.png`,
      `/v1/assets/nowhere/${id}.png`,
      `/v1/assets/gamma/${id}.png`,
    ]) {
      const res = await publicGet(path);
      expect([path, ...answer(res)]).toEqual([path, 404, "NOT_FOUND"]);
      expectResponseToMatch("getPublicAsset", res);
      expect(res.headers["cache-control"]).not.toContain("immutable");
    }
    const svg = await publicGet(`/v1/assets/alpha/${id}.svg`);
    expect(answer(svg)).toEqual([400, "VALIDATION_FAILED"]);
  });

  it("serves the path's OTA whatever credential comes with it, and refuses a wrong key", async () => {
    const asset = await uploaded(alphaOwner, "page_image", uniquePng());
    const path = pathOf(asset["url"]);

    expect((await publicGet(path).set(edgeHeaders(ALPHA_HOST))).status).toBe(200);
    expect((await publicGet(path).set(edgeHeaders(BETA_HOST))).status).toBe(200);
    expect((await publicGet(path).set("X-Api-Key", betaSk)).status).toBe(200);
    expect((await publicGet(path).set(edgeHeaders("unknown.example.net"))).status).toBe(200);
    // A credential sent along is still checked as on every route, with the answers the document lists.
    const refusals = [
      [await publicGet(path).set("X-Api-Key", newApiKey("sk")), [401, "INVALID_API_KEY"]],
      [
        await publicGet(path).set(edgeHeaders(ALPHA_HOST)).set("X-Api-Key", alphaSk),
        [400, "INVALID_REQUEST"],
      ],
      [
        await publicGet(path).set("X-Api-Key", betaSk).set("X-Velexis-Scope", "console"),
        [403, "SCOPE_NOT_ALLOWED"],
      ],
    ] as const;
    for (const [res, expected] of refusals) {
      expect(answer(res)).toEqual(expected);
      expectResponseToMatch("getPublicAsset", res);
    }
    // A console:automation key in console scope: no tenant is resolved, so the console audit, which writes a refusal
    // into the tenant of the request, writes nothing and never turns the answer into an error of its own.
    const automationKey = await insertSecretKey(alphaId, ["console:automation", "settings:read"]);
    const unknown = await publicGet(`/v1/assets/alpha/${newId("ast")}.png`)
      .set("X-Api-Key", automationKey)
      .set("X-Velexis-Scope", "console");
    const known = await publicGet(path).set("X-Api-Key", automationKey).set("X-Velexis-Scope", "console");
    expect([answer(unknown), known.status]).toEqual([[404, "NOT_FOUND"], 200]);
  });

  it("answers a stored file that changed 500 and a missing one 404, never other bytes", async () => {
    const png = uniquePng();
    const asset = await uploaded(alphaOwner, "page_image", png);
    const storageKey = `tenant_alpha/assets/${sha256(png)}.png`;

    writeFileSync(join(storageDir, storageKey), Buffer.concat([png, Buffer.from("tampered")]));
    expect(answer(await publicGet(pathOf(asset["url"])))).toEqual([500, "INTERNAL_ERROR"]);
    rmSync(join(storageDir, storageKey));
    expect(answer(await publicGet(pathOf(asset["url"])))).toEqual([404, "NOT_FOUND"]);
    // The same image uploaded again stores its file again.
    expect((await uploaded(alphaOwner, "page_image", png))["id"]).toBe(asset["id"]);
    expect((await publicGet(pathOf(asset["url"]))).status).toBe(200);
  });

  it("counts the images with the document downloads, 120 per minute per IP", async () => {
    const asset = await uploaded(alphaOwner, "page_image", uniquePng(8, 8));
    const path = pathOf(asset["url"]);
    const ip = newVisitorIp();
    // 119 requests of this minute already counted (images or documents: one bucket).
    await redis.client.set(`rl:ota_downloads:${trackerDigest("ip", ip)}`, "119", "EX", 60);

    const last = await publicGet(path, ip);
    const limited = await publicGet(path, ip);
    const otherIp = await publicGet(path);

    expect(last.status).toBe(200);
    expect(answer(limited)).toEqual([429, "RATE_LIMITED"]);
    expectResponseToMatch("getPublicAsset", limited);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(otherIp.status).toBe(200);
  });
});

describe("storefront.get", () => {
  it("gives the edge same-origin /api/v1/assets/ paths and key callers absolute URLs, both served", async () => {
    const asset = await uploaded(alphaOwner, "logo", uniquePng());
    await useAsLogo("tenant_alpha", String(asset["id"]));
    // Written behind the settings service's back: its cache entries go as an update deletes them.
    const cached = await redis.client.keys(`t:${alphaId}:*:sf:*`);
    if (cached.length > 0) {
      await redis.client.del(...cached);
    }

    const edge = await request(api.server).get("/v1/storefront").set(edgeHeaders(ALPHA_HOST));
    const key = await request(api.server).get("/v1/storefront").set("X-Api-Key", alphaSk);

    expect([edge.status, key.status]).toEqual([200, 200]);
    const path = `/v1/assets/alpha/${String(asset["id"])}.png`;
    expect(edge.body.branding.logoUrl).toBe(`/api${path}`);
    expect(key.body.branding.logoUrl).toBe(`${PUBLIC_API}${path}`);
    // Caddy strips `/api` before the API sees the edge's request.
    expect(
      (await publicGet(String(edge.body.branding.logoUrl).replace(/^\/api/, "")).set(edgeHeaders(ALPHA_HOST)))
        .status,
    ).toBe(200);
    await useAsLogo("tenant_alpha", null);
  });
});

describe("a suspended OTA", () => {
  it("still serves its images, also through its storefront's edge, while its storefront answers 403", async () => {
    const asset = await uploaded(betaOwner, "logo", uniquePng());
    await migrator
      .updateTable("platform.tenants")
      .set({ status: "suspended", suspension_reason: "billing" })
      .where("id", "=", betaId)
      .execute();
    // The platform publishes the change on vx:invalidate; dropping the cached rows has the same effect at once.
    await redis.client.del(redisKeys.tenant(betaId).key, redisKeys.tenantByKey("beta").key);

    const storefront = await request(api.server).get("/v1/storefront").set(edgeHeaders(BETA_HOST));
    const viaEdge = await publicGet(pathOf(asset["url"])).set(edgeHeaders(BETA_HOST));
    const anonymous = await publicGet(pathOf(asset["url"]));

    expect(answer(storefront)).toEqual([403, "TENANT_SUSPENDED"]);
    expect([viaEdge.status, anonymous.status]).toEqual([200, 200]);
  });
});
