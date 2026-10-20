// The provisioning seeds against PostgreSQL 16 (OBE-004; OADR-0007 item 4): each test provisions its own tenant
// schema with the real runner (`migrateTenantSchema({ create: true })` as velexis_provisioner, the role of the OTA
// worker), seeds it in a tenant transaction of that role, and reads the rows back as velexis_ota_app.
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, createTenantDb, sql, tenantTx, type TenantDb } from "@velexis/db";
import { BASELINE_FILE, migrateTenantSchema } from "@velexis/db/migrate";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { APP_DIR } from "../../../src/config";
import {
  loadTemplateDefaults,
  TEMPLATE_KEYS,
  TEMPLATE_PARTS,
  TEMPLATE_REGISTRY,
  templateFileName,
  type TemplateKey,
} from "../../../src/notifications/templates/registry";
import {
  seedTenant,
  STOREFRONT_SETTINGS_0002_COLUMNS,
  storefrontSettingsColumns,
  type SeedTenant,
} from "../../../src/provisioning/seeds";

const TENANT_MIGRATIONS_DIR = join(APP_DIR, "migrations", "tenant");
const TENANT: SeedTenant = { name: "Acme Travel", defaultCurrency: "GBP", defaultLocale: "en-GB" };
const NOW = new Date("2026-10-14T09:30:00.000Z");
const LATER = new Date("2026-10-15T09:30:00.000Z");
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** The schemas this file provisions, one per test, so no test depends on another. */
const SCHEMAS = {
  fresh: "tenant_seed_fresh",
  edited: "tenant_seed_edited",
  allTemplates: "tenant_seed_all_templates",
  twoTemplates: "tenant_seed_two_templates",
  schemaN: "tenant_seed_schema_n",
  rolledBack: "tenant_seed_rolled_back",
} as const;
/** A schema at version N-1 (the baseline only), provisioned by its test from a folder without migration 0002. */
const SCHEMA_N_MINUS_1 = "tenant_seed_schema_n_minus_1";

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let provisionerPool: ReturnType<typeof createPool>;
let otaPool: ReturnType<typeof createPool>;
/** The provisioning role, which runs the seeds in the worker. */
let provisioner: TenantDb;
/** The application role, which reads and edits the seeded rows. */
let app: TenantDb;
let fixtureDirs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  for (const schema of Object.values(SCHEMAS)) {
    await migrateTenantSchema({
      schema,
      dir: TENANT_MIGRATIONS_DIR,
      url: db.urlFor("provisioner"),
      create: true,
    });
  }
  provisionerPool = createPool(db.urlFor("provisioner"), {
    applicationName: "ota-worker-test",
    logger: quietPoolLogger,
    max: 2,
  });
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-api-test",
    logger: quietPoolLogger,
    max: 2,
  });
  provisioner = createTenantDb(provisionerPool, { appEnv: "test" });
  app = createTenantDb(otaPool, { appEnv: "test" });
});

afterAll(async () => {
  await provisionerPool?.end();
  await otaPool?.end();
  await db?.drop();
  for (const dir of fixtureDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  fixtureDirs = [];
});

/** A fixture folder with the three default files of each of `keys`. */
async function templateFixture(keys: readonly TemplateKey[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-obe004-templates-"));
  fixtureDirs.push(dir);
  for (const key of keys) {
    const parts: Record<(typeof TEMPLATE_PARTS)[number], string> = {
      subject: `{{brand.name}}: ${key}\n`,
      html: `<p>{{brand.name}}</p>\n<p>${key}</p>\n`,
      txt: `{{brand.name}}\n${key}\n`,
    };
    for (const part of TEMPLATE_PARTS) {
      await writeFile(join(dir, templateFileName(key, part)), parts[part], "utf8");
    }
  }
  return dir;
}

/** Every row of the three seeded tables of `schema`, read as velexis_ota_app. */
async function seededRows(schema: string) {
  return await tenantTx(app, schema, async (trx) => ({
    settings: await trx.selectFrom("storefront_settings").selectAll().execute(),
    markupRules: await trx.selectFrom("markup_rules").selectAll().orderBy("id").execute(),
    templates: await trx.selectFrom("notification_templates").selectAll().orderBy("key").execute(),
  }));
}

describe("seedTenant", () => {
  it("creates one settings row and one default markup rule on a fresh schema; a second run changes nothing [OBE-004 AC1]", async () => {
    // The code defaults that ship: OBE-030's account e-mails; OBE-055 adds the booking and staff ones.
    const shipped = (await loadTemplateDefaults()).map((source) => source.key);
    expect(shipped).toEqual(expect.arrayContaining(["auth.verify_email", "auth.password_reset"]));

    const first = await tenantTx(provisioner, SCHEMAS.fresh, (trx) => seedTenant(trx, TENANT, { now: NOW }));

    expect(first).toEqual({
      storefrontSettings: true,
      defaultMarkupRule: true,
      notificationTemplates: shipped,
    });
    const rows = await seededRows(SCHEMAS.fresh);
    expect(rows.settings).toHaveLength(1);
    expect(rows.settings[0]).toMatchObject({
      id: "sfs_default",
      brand_name: "Acme Travel",
      default_currency: "GBP",
      supported_currencies: ["GBP"],
      default_locale: "en-GB",
      supported_locales: ["en-GB"],
      ticketing_policy: "issue_after_payment",
      auto_issue: true,
      payment_timing: "authorize_before_booking",
      version: 1,
    });
    expect(rows.markupRules).toHaveLength(1);
    const [rule] = rows.markupRules;
    expect(rule).toMatchObject({
      name: "Default",
      calculation: "percentage",
      percentage: "0.0000",
      fixed_amount: null,
      priority: 1000,
      scope: {},
      stackable: false,
      is_default: true,
      is_active: true,
      active_from: null,
      active_until: null,
      version: 1,
    });
    expect(rule?.id).toMatch(new RegExp(`^mkr_${ULID}$`));
    // The id's timestamp part comes from `now`.
    expect(rule?.id.slice(0, 14)).toBe(newId("mkr", NOW).slice(0, 14));
    // One system row per shipped default; every other key uses the code fallback at send time.
    expect(rows.templates.map((row) => [row.key, row.locale, row.is_system, row.is_active])).toEqual(
      [...shipped].sort().map((key) => [key, "en", true, true]),
    );

    const second = await tenantTx(provisioner, SCHEMAS.fresh, (trx) =>
      seedTenant(trx, TENANT, { now: LATER }),
    );

    expect(second).toEqual({
      storefrontSettings: false,
      defaultMarkupRule: false,
      notificationTemplates: [],
    });
    expect(await seededRows(SCHEMAS.fresh)).toEqual(rows);
  });

  it("keeps a settings row and a default rule the OTA edited when it runs again [OBE-004 AC2]", async () => {
    await tenantTx(provisioner, SCHEMAS.edited, (trx) => seedTenant(trx, TENANT, { now: NOW }));
    await tenantTx(app, SCHEMAS.edited, async (trx) => {
      await trx
        .updateTable("storefront_settings")
        .set({
          brand_name: "Acme Holidays",
          default_currency: "EUR",
          supported_currencies: ["EUR", "GBP"],
          ticketing_policy: "manual_review",
          support_email: "help@acme.example.com",
          version: 2,
        })
        .execute();
      await trx
        .updateTable("markup_rules")
        .set({ percentage: "4.5", is_active: false, version: 2 })
        .where("is_default", "=", true)
        .execute();
    });
    const edited = await seededRows(SCHEMAS.edited);

    const again = await tenantTx(provisioner, SCHEMAS.edited, (trx) =>
      seedTenant(trx, { name: "Renamed", defaultCurrency: "USD", defaultLocale: "fr" }, { now: LATER }),
    );

    expect(again).toEqual({ storefrontSettings: false, defaultMarkupRule: false, notificationTemplates: [] });
    const rows = await seededRows(SCHEMAS.edited);
    expect(rows).toEqual(edited);
    expect(rows.settings[0]).toMatchObject({
      brand_name: "Acme Holidays",
      default_currency: "EUR",
      supported_currencies: ["EUR", "GBP"],
      ticketing_policy: "manual_review",
      support_email: "help@acme.example.com",
      version: 2,
    });
    expect(rows.markupRules).toHaveLength(1);
    expect(rows.markupRules[0]).toMatchObject({ percentage: "4.5000", is_active: false, is_default: true });
  });

  it("seeds one notification_templates row per key whose default files exist [OBE-004 AC3]", async () => {
    const dir = await templateFixture(TEMPLATE_KEYS);

    const first = await tenantTx(provisioner, SCHEMAS.allTemplates, (trx) =>
      seedTenant(trx, TENANT, { now: NOW, templatesDir: dir }),
    );

    expect(first.notificationTemplates).toEqual(TEMPLATE_KEYS);
    const { templates } = await seededRows(SCHEMAS.allTemplates);
    expect(templates.map((row) => row.key)).toEqual([...TEMPLATE_KEYS].sort());
    for (const row of templates) {
      const key = row.key as TemplateKey;
      expect(row).toMatchObject({
        channel: "email",
        locale: "en",
        subject: `{{brand.name}}: ${key}`,
        body_html: `<p>{{brand.name}}</p>\n<p>${key}</p>\n`,
        body_text: `{{brand.name}}\n${key}\n`,
        is_system: true,
        is_active: true,
        version: 1,
      });
      expect(row.sample_data).toEqual(JSON.parse(JSON.stringify(TEMPLATE_REGISTRY[key].sampleData)));
      expect(row.id).toMatch(new RegExp(`^ntt_${ULID}$`));
    }

    // A template the OTA edited is kept, and nothing is inserted twice.
    await tenantTx(app, SCHEMAS.allTemplates, (trx) =>
      trx
        .updateTable("notification_templates")
        .set({ subject: "Your booking with {{brand.name}}", is_system: false, version: 2 })
        .where("key", "=", "booking.confirmed")
        .execute(),
    );
    const edited = await seededRows(SCHEMAS.allTemplates);

    const second = await tenantTx(provisioner, SCHEMAS.allTemplates, (trx) =>
      seedTenant(trx, TENANT, { now: LATER, templatesDir: dir }),
    );

    expect(second.notificationTemplates).toEqual([]);
    expect(await seededRows(SCHEMAS.allTemplates)).toEqual(edited);
  });

  it("seeds only the keys whose files exist, one row each [OBE-004 AC3]", async () => {
    const dir = await templateFixture(["staff.manual_review", "auth.verify_email"]);

    const result = await tenantTx(provisioner, SCHEMAS.twoTemplates, (trx) =>
      seedTenant(trx, TENANT, { now: NOW, templatesDir: dir }),
    );

    expect(result.notificationTemplates).toEqual(["auth.verify_email", "staff.manual_review"]);
    const { templates } = await seededRows(SCHEMAS.twoTemplates);
    expect(templates.map((row) => [row.key, row.channel, row.locale])).toEqual([
      ["auth.verify_email", "email", "en"],
      ["staff.manual_review", "email", "en"],
    ]);
  });

  it("writes the columns of migration 0002 only on a schema that has them", async () => {
    // Schema N-1: the baseline only, as a tenant provisioned by the previous release is until the deploy fan-out
    // applies 0002 to it. The seed still inserts its row there, without the columns of 0002.
    const previousRelease = await mkdtemp(join(tmpdir(), "velexis-obe004-n-minus-1-"));
    fixtureDirs.push(previousRelease);
    await copyFile(join(TENANT_MIGRATIONS_DIR, BASELINE_FILE), join(previousRelease, BASELINE_FILE));
    await migrateTenantSchema({
      schema: SCHEMA_N_MINUS_1,
      dir: previousRelease,
      url: db.urlFor("provisioner"),
      create: true,
    });
    const baseline = await tenantTx(provisioner, SCHEMA_N_MINUS_1, (trx) => storefrontSettingsColumns(trx));
    for (const column of STOREFRONT_SETTINGS_0002_COLUMNS) {
      expect(baseline.has(column)).toBe(false);
    }
    const previous = await tenantTx(provisioner, SCHEMA_N_MINUS_1, (trx) =>
      seedTenant(trx, TENANT, { now: NOW }),
    );
    expect(previous.storefrontSettings).toBe(true);
    expect((await seededRows(SCHEMA_N_MINUS_1)).settings).toEqual([
      expect.objectContaining({ id: "sfs_default", brand_name: "Acme Travel", default_currency: "GBP" }),
    ]);

    // Schema N: every file of migrations/tenant, so the storefront_settings columns of 0002_add_mvp_tenant_deltas
    // (data-model-migration-0002.md §6, OBE-008) that the seed writes.
    const current = await tenantTx(provisioner, SCHEMAS.schemaN, (trx) => storefrontSettingsColumns(trx));
    for (const column of STOREFRONT_SETTINGS_0002_COLUMNS) {
      expect(current.has(column)).toBe(true);
    }

    const result = await tenantTx(provisioner, SCHEMAS.schemaN, (trx) =>
      seedTenant(trx, TENANT, { now: NOW }),
    );

    expect(result.storefrontSettings).toBe(true);
    const rows = await tenantTx(app, SCHEMAS.schemaN, async (trx) => {
      const { rows: found } = await sql<Record<string, unknown>>`
        SELECT time_zone, booking_queue_number, booking_queue_category, airline_card_enabled_test,
               airline_card_enabled_live, brand_name
        FROM storefront_settings
      `.execute(trx);
      return found;
    });
    expect(rows).toEqual([
      {
        time_zone: "UTC",
        booking_queue_number: 50,
        booking_queue_category: 0,
        airline_card_enabled_test: false,
        airline_card_enabled_live: false,
        brand_name: "Acme Travel",
      },
    ]);
  });

  it("runs inside the caller's transaction: a rollback leaves nothing behind", async () => {
    const dir = await templateFixture(["booking.confirmed"]);

    await expect(
      tenantTx(provisioner, SCHEMAS.rolledBack, async (trx) => {
        await seedTenant(trx, TENANT, { now: NOW, templatesDir: dir });
        throw new Error("provisioning failed after the seeds");
      }),
    ).rejects.toThrow("provisioning failed after the seeds");

    expect(await seededRows(SCHEMAS.rolledBack)).toEqual({ settings: [], markupRules: [], templates: [] });
  });

  it("seeds only the schema of its transaction (tenant_alpha, not tenant_beta)", async () => {
    const dir = await templateFixture(["auth.password_reset"]);

    await tenantTx(provisioner, "tenant_alpha", (trx) =>
      seedTenant(trx, TENANT, { now: NOW, templatesDir: dir }),
    );

    const alpha = await seededRows("tenant_alpha");
    expect([alpha.settings.length, alpha.markupRules.length, alpha.templates.length]).toEqual([1, 1, 1]);
    expect(await seededRows("tenant_beta")).toEqual({ settings: [], markupRules: [], templates: [] });
  });
});
