// console.settings.templates.* without PostgreSQL (OBE-073): the templates as the OTA document shows them (checked
// with the checker of the integration tests), the 422 TEMPLATE_INVALID of a template that does not compile or uses a
// variable outside its key's allow-list, the preview's render data (the sample data, the variables sent in their place)
// and its escaping, and the service's order of checks, writes and audit rows over an in-memory TemplateService whose
// rows behave as the SQL's (one per key, channel and locale; versions; a concurrent insert). The SQL, the pipeline, the
// permissions and the next e-mail after a put and a reset are test/integration/settings/templates.int.test.ts.
import { AppError } from "@velexis/errors";
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../common/clock";
import { newId, type IdGenerator } from "../common/ids";
import type { StaffActionEntry, StaffActionsWriter } from "../console/staff-actions.writer";
import type { NotificationTemplateRow, OutboxRepository } from "../notifications/outbox.repository";
import { MAX_VARIABLE_LENGTH } from "../notifications/renderer";
import {
  compileTemplate,
  TemplateRenderError,
  TemplateService,
  type TemplateRowValues,
} from "../notifications/template.service";
import {
  TEMPLATE_KEYS,
  TEMPLATE_REGISTRY,
  type SampleData,
  type TemplateKey,
} from "../notifications/templates/registry";
import type { StorefrontRepository } from "../storefront/storefront.repository";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  previewData,
  renderErrorOf,
  templateErrorsOf,
  TemplateSettingsService,
  templateTargetId,
  type TemplateAddress,
} from "./templates.service";

let checker: ResponseChecker;

// Parsing the OTA document and compiling the response validators of the five operations takes about a second alone,
// several times that while every package's tests run at once on a 4-CPU runner; the code defaults are read and
// compiled once per process too. Both are paid here, with a budget that only stops a hang.
beforeAll(async () => {
  checker = responseChecker("ota");
  for (const operationId of [
    "consoleListNotificationTemplates",
    "consoleGetNotificationTemplate",
    "consolePutNotificationTemplate",
    "consolePreviewNotificationTemplate",
    "consoleResetNotificationTemplate",
  ] as const) {
    checker.check(operationId, { status: 200, body: {} });
  }
  for (const key of TEMPLATE_KEYS) {
    await SHARED_DEFAULTS.codeDefault(key);
  }
}, 60_000);

const NOW = new Date("2026-10-28T09:00:00.000Z");
const SEEDED = new Date("2026-10-01T08:00:00.000Z");
const TRX = {} as TenantTransaction;

/** Nothing reads e-mail rows here: the outbox's repository is never used by the console paths. */
const NO_OUTBOX = {} as OutboxRepository;

/** Reads the code defaults once for the whole file (the service keeps them per instance). */
const SHARED_DEFAULTS = new TemplateService(NO_OUTBOX);

const rowKey = (key: string, locale: string): string => `${key}\u0000${locale}`;

/**
 * The TemplateService with its rows in memory, as `notification_templates` keeps them: one row per key, channel and
 * locale; an insert of an existing one does nothing; an update needs the row's version.
 */
class MemoryTemplates extends TemplateService {
  readonly rows = new Map<string, NotificationTemplateRow>();
  /** Inserted before the next insert runs: a concurrent put that commits first. */
  concurrentInsert: NotificationTemplateRow | undefined;

  constructor() {
    super(NO_OUTBOX);
  }

  override codeDefault(key: TemplateKey) {
    return SHARED_DEFAULTS.codeDefault(key);
  }

  override tenantRow(_trx: TenantTransaction, key: TemplateKey, locale: string) {
    return Promise.resolve(this.rows.get(rowKey(key, locale)));
  }

  override tenantRows(_trx: TenantTransaction, locales: readonly string[], key?: TemplateKey) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) => locales.includes(row.locale) && (key === undefined || row.key === key),
      ),
    );
  }

  override insertRow(
    _trx: TenantTransaction,
    id: string,
    key: TemplateKey,
    locale: string,
    values: TemplateRowValues,
  ) {
    if (this.concurrentInsert !== undefined) {
      this.add(this.concurrentInsert);
      this.concurrentInsert = undefined;
    }
    if (this.rows.has(rowKey(key, locale))) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.add(
        storedRow({
          id,
          key,
          locale,
          subject: values.subject,
          body_html: values.html,
          body_text: values.text,
          is_active: values.isActive,
          is_system: false,
          created_at: values.now,
          updated_at: values.now,
        }),
      ),
    );
  }

  override updateRow(_trx: TenantTransaction, id: string, version: number, values: TemplateRowValues) {
    const row = [...this.rows.values()].find((entry) => entry.id === id && entry.version === version);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.add({
        ...row,
        subject: values.subject,
        body_html: values.html,
        body_text: values.text,
        is_active: values.isActive,
        is_system: false,
        version: version + 1,
        updated_at: values.now,
      }),
    );
  }

  override deleteRow(_trx: TenantTransaction, key: TemplateKey, locale: string) {
    const row = this.rows.get(rowKey(key, locale));
    this.rows.delete(rowKey(key, locale));
    return Promise.resolve(row);
  }

  add(row: NotificationTemplateRow): NotificationTemplateRow {
    this.rows.set(rowKey(row.key, row.locale), row);
    return row;
  }
}

/** A stored row with the column defaults of a seeded template. */
function storedRow(
  overrides: Partial<NotificationTemplateRow> & { key: string; locale: string },
): NotificationTemplateRow {
  return {
    id: newId("ntt", SEEDED),
    channel: "email",
    subject: "Booked {{booking.reference}}",
    body_html: "<p>{{booking.reference}}</p>",
    body_text: "{{booking.reference}}",
    sample_data: {},
    is_system: true,
    is_active: true,
    version: 1,
    created_at: SEEDED,
    updated_at: SEEDED,
    ...overrides,
  };
}

interface Harness {
  readonly service: TemplateSettingsService;
  readonly templates: MemoryTemplates;
  readonly audit: StaffActionEntry[];
  /** How many transactions the service opened. */
  readonly transactions: () => number;
}

function harness(options: { supportedLocales?: readonly string[] | null } = {}): Harness {
  const templates = new MemoryTemplates();
  const audit: StaffActionEntry[] = [];
  let transactions = 0;
  const tx = {
    run: <T>(fn: (trx: TenantTransaction) => Promise<T>) => {
      transactions += 1;
      return fn(TRX);
    },
  } as unknown as TenantTx;
  const supported = options.supportedLocales === undefined ? ["fr", "en"] : options.supportedLocales;
  const storefront = {
    settings: () => Promise.resolve(supported === null ? undefined : { supportedLocales: supported }),
  } as unknown as StorefrontRepository;
  const writer = {
    record: (_trx: TenantTransaction, entry: StaffActionEntry) => {
      audit.push(entry);
      return Promise.resolve();
    },
  } as unknown as StaffActionsWriter;
  // The service makes `ntt_` ids only.
  const ids = { newId: (prefix: "ntt") => newId(prefix, NOW) } as unknown as IdGenerator;
  const clock = { now: () => NOW } as unknown as Clock;
  return {
    service: new TemplateSettingsService(tx, templates, storefront, writer, ids, clock),
    templates,
    audit,
    transactions: () => transactions,
  };
}

const CONFIRMED_EN: TemplateAddress = { key: "booking.confirmed", channel: "email", locale: "en" };

/** The error a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

const GOOD_INPUT = {
  subject: "Your trip {{booking.reference}} is confirmed",
  bodyHtml:
    "<p>Hello {{booking.contact.firstName}},</p><p>Your booking {{booking.reference}} is confirmed.</p>",
  bodyText: "Hello {{booking.contact.firstName}},\nYour booking {{booking.reference}} is confirmed.",
};

/* ------------------------------------------------------------------------------------------------
 * The templates as the document shows them
 * ---------------------------------------------------------------------------------------------- */

describe("console.settings.templates.list and get", () => {
  it("lists every key the code knows for every supported locale, by key then locale, the OTA's edited rows customised, the seeded rows and the code defaults not [FIX-W33-OTA]", async () => {
    const { service, templates } = harness({ supportedLocales: ["fr", "en", "fr"] });
    // Seeded by provisioning from the code default (`is_system`) and never edited: a row, yet not customised.
    const seeded = templates.add(storedRow({ key: "booking.confirmed", locale: "en" }));
    const edited = templates.add(
      storedRow({ key: "booking.cancelled", locale: "en", is_system: false, version: 2 }),
    );
    // A row of a locale the storefront does not offer is not listed.
    templates.add(storedRow({ key: "booking.confirmed", locale: "de" }));

    const list = await service.list();

    expect(checker.check("consoleListNotificationTemplates", { status: 200, body: list })).toEqual([]);
    const sortedKeys = [...TEMPLATE_KEYS].sort();
    expect(list.data.map((template) => `${template.key}/${template.locale}`)).toEqual(
      sortedKeys.flatMap((key) => [`${key}/en`, `${key}/fr`]),
    );
    const confirmedEn = list.data.find((item) => item.key === "booking.confirmed" && item.locale === "en");
    expect(confirmedEn).toMatchObject({
      customised: false,
      inheritedFrom: null,
      isActive: true,
      version: 1,
      subject: seeded.subject,
      updatedAt: SEEDED.toISOString(),
    });
    const cancelledEn = list.data.find((item) => item.key === "booking.cancelled" && item.locale === "en");
    expect(cancelledEn).toMatchObject({
      customised: true,
      inheritedFrom: null,
      version: 2,
      subject: edited.subject,
    });
    const confirmedFr = list.data.find((item) => item.key === "booking.confirmed" && item.locale === "fr");
    const fallback = await SHARED_DEFAULTS.codeDefault("booking.confirmed");
    expect(confirmedFr).toEqual({
      key: "booking.confirmed",
      channel: "email",
      locale: "fr",
      subject: fallback?.template.sources.subject,
      bodyHtml: fallback?.template.sources.html,
      bodyText: fallback?.template.sources.text,
      variables: TEMPLATE_REGISTRY["booking.confirmed"].variables.map(({ name, description }) => ({
        name,
        description,
      })),
      customised: false,
      inheritedFrom: null,
      isActive: true,
      version: null,
      updatedAt: null,
    });
  });

  it("answers 403 TENANT_SUSPENDED to a list before the tenant's settings row exists", async () => {
    const { service } = harness({ supportedLocales: null });

    expect((await refusal(service.list())).code).toBe("TENANT_SUSPENDED");
  });

  it("gets the OTA's row, active or not, else the code default under the locale asked for", async () => {
    const { service, templates } = harness();
    templates.add(
      storedRow({ key: "booking.confirmed", locale: "en", is_active: false, is_system: false, version: 4 }),
    );

    const own = await service.get(CONFIRMED_EN);
    const fallback = await service.get({ ...CONFIRMED_EN, locale: "pt-BR" });

    for (const body of [own, fallback]) {
      expect(checker.check("consoleGetNotificationTemplate", { status: 200, body })).toEqual([]);
    }
    expect(own).toMatchObject({ customised: true, inheritedFrom: null, isActive: false, version: 4 });
    expect(fallback).toMatchObject({
      locale: "pt-BR",
      customised: false,
      inheritedFrom: null,
      isActive: true,
      version: null,
    });
    expect(fallback.subject).toBe("Your booking {{booking.reference}} with {{brand.name}} is confirmed");
  });

  it("[FIX-W33-OTA] [OBE-073] answers a seeded row as not customised, with its version, until a put with If-Match makes it the OTA's", async () => {
    const { service, templates } = harness();
    templates.add(storedRow({ key: "booking.confirmed", locale: "en", version: 1 }));

    const seeded = await service.get(CONFIRMED_EN);

    expect(checker.check("consoleGetNotificationTemplate", { status: 200, body: seeded })).toEqual([]);
    expect(seeded).toMatchObject({ customised: false, inheritedFrom: null, version: 1 });
    // Still a row: a put without If-Match is refused, and with it the row becomes the OTA's own.
    expect((await refusal(service.put(CONFIRMED_EN, GOOD_INPUT, undefined))).code).toBe(
      "PRECONDITION_FAILED",
    );
    expect(await service.put(CONFIRMED_EN, GOOD_INPUT, '"1"')).toMatchObject({
      customised: true,
      version: 2,
    });
  });
});

describe("console.settings.templates: the template that serves a locale without a row of its own (FIX-W33-OTA)", () => {
  const CONFIRMED_GB: TemplateAddress = { ...CONFIRMED_EN, locale: "en-GB" };

  it("[FIX-W33-OTA] [OBE-073] shows the language's active row that e-mails in the locale use, marked as inherited, in get and list", async () => {
    const { service, templates } = harness({ supportedLocales: ["en-GB", "fr"] });
    const language = templates.add(
      storedRow({
        key: "booking.confirmed",
        locale: "en",
        subject: "Booked {{booking.reference}}!",
        is_system: false,
      }),
    );
    const seededLanguage = templates.add(storedRow({ key: "booking.cancelled", locale: "en" }));

    const got = await service.get(CONFIRMED_GB);
    const list = await service.list();

    expect(checker.check("consoleGetNotificationTemplate", { status: 200, body: got })).toEqual([]);
    expect(checker.check("consoleListNotificationTemplates", { status: 200, body: list })).toEqual([]);
    expect(got).toMatchObject({
      locale: "en-GB",
      subject: language.subject,
      bodyHtml: language.body_html,
      inheritedFrom: "en",
      customised: true,
      isActive: true,
      version: null,
      updatedAt: null,
    });
    // What an e-mail in en-GB uses: the same row (template.service.ts `effective`, through `servingRowOf`).
    const effective = await new TemplateService({
      activeTemplates: (_trx: TenantTransaction, key: string) =>
        Promise.resolve([...templates.rows.values()].filter((row) => row.key === key && row.is_active)),
    } as unknown as OutboxRepository).effective(TRX, "booking.confirmed", "en-GB");
    expect(effective).toMatchObject({ origin: "tenant", templateId: language.id, locale: "en" });
    expect(list.data.find((item) => item.key === "booking.confirmed" && item.locale === "en-GB")).toEqual(
      got,
    );
    // A seeded language row is inherited too, and not customised.
    expect(
      list.data.find((item) => item.key === "booking.cancelled" && item.locale === "en-GB"),
    ).toMatchObject({
      inheritedFrom: "en",
      customised: false,
      subject: seededLanguage.subject,
    });
    // Without a row of the locale or its language: the code default.
    expect(list.data.find((item) => item.key === "booking.confirmed" && item.locale === "fr")).toMatchObject({
      inheritedFrom: null,
      customised: false,
    });
  });

  it("[FIX-W33-OTA] [OBE-073] shows the code default when the language's row is inactive, and the locale's own row when it has one", async () => {
    const { service, templates } = harness({ supportedLocales: ["en-GB"] });
    templates.add(storedRow({ key: "booking.confirmed", locale: "en", is_active: false, is_system: false }));

    const inactiveLanguage = await service.get(CONFIRMED_GB);
    templates.add(storedRow({ key: "booking.confirmed", locale: "en-GB", is_system: false, version: 3 }));
    const own = await service.get(CONFIRMED_GB);

    expect(inactiveLanguage).toMatchObject({ inheritedFrom: null, customised: false, version: null });
    expect(inactiveLanguage.subject).toBe(
      "Your booking {{booking.reference}} with {{brand.name}} is confirmed",
    );
    expect(own).toMatchObject({ locale: "en-GB", inheritedFrom: null, customised: true, version: 3 });
  });

  it("[FIX-W33-OTA] [OBE-073] writes the locale's own row on put without If-Match, never the language's, and previews what the locale shows", async () => {
    const { service, templates } = harness({ supportedLocales: ["en-GB"] });
    const language = templates.add(
      storedRow({
        key: "booking.confirmed",
        locale: "en",
        subject: "Booked {{booking.reference}}!",
        is_system: false,
      }),
    );

    const preview = await service.preview(CONFIRMED_GB, undefined);
    const withIfMatch = await refusal(service.put(CONFIRMED_GB, GOOD_INPUT, '"1"'));
    const saved = await service.put(CONFIRMED_GB, GOOD_INPUT, undefined);

    expect(preview.subject).toBe("Booked VX7K2M9Q!");
    expect(withIfMatch.code).toBe("PRECONDITION_FAILED");
    expect(saved).toMatchObject({ locale: "en-GB", inheritedFrom: null, customised: true, version: 1 });
    expect(templates.rows.get(rowKey("booking.confirmed", "en"))).toEqual(language);
    expect(templates.rows.get(rowKey("booking.confirmed", "en-GB"))).toMatchObject({
      subject: GOOD_INPUT.subject,
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * put
 * ---------------------------------------------------------------------------------------------- */

describe("console.settings.templates.put", () => {
  it("[OBE-073 AC1] refuses a template that does not compile or uses an unknown variable with 422 TEMPLATE_INVALID, every problem by part and line, and reads nothing", async () => {
    const { service, templates, audit, transactions } = harness();

    const error = await refusal(
      service.put(
        CONFIRMED_EN,
        {
          subject: "Booking {{booking.pnr}}",
          bodyHtml: "<p>Hello</p>\n<p>{{#if booking.reference}}\n{{/each}}</p>",
          bodyText:
            "Hello {{booking.contact.firstName}}\n{{{booking.reference}}}\n{{lookup booking 'reference'}}",
        },
        undefined,
      ),
    );

    expect(error.code).toBe("TEMPLATE_INVALID");
    expect(error.status).toBe(422);
    expect(error.details).toEqual({
      errors: [
        { part: "subject", line: 1, message: '"booking.pnr" is not a variable of booking.confirmed' },
        { part: "bodyHtml", line: 2, message: expect.stringMatching(/^does not parse/) as unknown },
        {
          part: "bodyText",
          line: 2,
          message: "triple braces would turn HTML escaping off: use {{variable}}",
        },
        {
          part: "bodyText",
          line: 3,
          message: "helpers are not available: use {{variable}}, {{#if}}, {{#unless}} or {{#each}}",
        },
      ],
    });
    expect(transactions()).toBe(0);
    expect(templates.rows.size).toBe(0);
    expect(audit).toEqual([]);
  });

  it("[OBE-073 AC1] refuses a link variable in the subject and a variable of another key", async () => {
    const { service } = harness();

    const error = await refusal(
      service.put(
        { key: "auth.verify_email", channel: "email", locale: "en" },
        {
          subject: "Confirm: {{verifyUrl}}",
          bodyHtml: '<a href="{{verifyUrl}}">Confirm</a>',
          bodyText: "{{verifyUrl}} for {{booking.reference}}",
        },
        undefined,
      ),
    );

    expect(error.details).toEqual({
      errors: [
        {
          part: "subject",
          line: 1,
          message: '"verifyUrl" holds a secret link and may not appear in the subject',
        },
        { part: "bodyText", line: 1, message: '"booking.reference" is not a variable of auth.verify_email' },
      ],
    });
  });

  it("creates the OTA's row at version 1 without If-Match, and records it before null and after", async () => {
    const { service, templates, audit } = harness();

    const saved = await service.put(CONFIRMED_EN, GOOD_INPUT, undefined);

    expect(checker.check("consolePutNotificationTemplate", { status: 200, body: saved })).toEqual([]);
    expect(saved).toMatchObject({
      ...GOOD_INPUT,
      locale: "en",
      customised: true,
      isActive: true,
      version: 1,
      updatedAt: NOW.toISOString(),
    });
    const row = templates.rows.get(rowKey("booking.confirmed", "en"));
    expect(row).toMatchObject({ is_system: false, is_active: true, version: 1 });
    expect(audit).toEqual([
      {
        action: "settings.templates.put",
        targetType: "notification_template",
        targetId: "booking.confirmed/email/en",
        before: null,
        after: {
          id: row?.id,
          key: "booking.confirmed",
          channel: "email",
          locale: "en",
          subject: GOOD_INPUT.subject,
          bodyHtml: GOOD_INPUT.bodyHtml,
          bodyText: GOOD_INPUT.bodyText,
          isActive: true,
          version: 1,
        },
      },
    ]);
  });

  it("replaces an existing row only with its current version in If-Match (quoted, as an ETag), at version + 1", async () => {
    const { service, templates, audit } = harness();
    const seeded = templates.add(storedRow({ key: "booking.confirmed", locale: "en", version: 3 }));

    for (const ifMatch of [undefined, '"2"', 'W/"4"', "abc"]) {
      expect((await refusal(service.put(CONFIRMED_EN, GOOD_INPUT, ifMatch))).code).toBe(
        "PRECONDITION_FAILED",
      );
    }
    const saved = await service.put(CONFIRMED_EN, { ...GOOD_INPUT, isActive: false }, '"3"');

    expect(saved).toMatchObject({ version: 4, isActive: false, customised: true });
    expect(templates.rows.get(rowKey("booking.confirmed", "en"))).toMatchObject({
      id: seeded.id,
      version: 4,
      is_system: false,
      is_active: false,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      before: { id: seeded.id, version: 3, subject: seeded.subject, isActive: true },
      after: { id: seeded.id, version: 4, subject: GOOD_INPUT.subject, isActive: false },
    });
  });

  it("answers 412 to an If-Match without a row, and to a put whose row a concurrent put inserted first", async () => {
    const { service, templates, audit } = harness();

    expect((await refusal(service.put(CONFIRMED_EN, GOOD_INPUT, '"1"'))).code).toBe("PRECONDITION_FAILED");
    templates.concurrentInsert = storedRow({ key: "booking.confirmed", locale: "en", is_system: false });
    expect((await refusal(service.put(CONFIRMED_EN, GOOD_INPUT, undefined))).code).toBe(
      "PRECONDITION_FAILED",
    );
    expect(audit).toEqual([]);
  });

  it("refuses a locale the storefront does not offer with 422 UNPROCESSABLE locale_not_supported", async () => {
    const { service, templates } = harness({ supportedLocales: ["en"] });

    const error = await refusal(service.put({ ...CONFIRMED_EN, locale: "de" }, GOOD_INPUT, undefined));

    expect([error.code, error.status, error.details]).toEqual([
      "UNPROCESSABLE",
      422,
      { reason: "locale_not_supported" },
    ]);
    expect(error.message).toBe("The storefront does not offer the locale de.");
    expect(templates.rows.size).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * preview
 * ---------------------------------------------------------------------------------------------- */

describe("the preview's render data", () => {
  it("is the key's sample data without variables", () => {
    expect(previewData("booking.confirmed", undefined)).toEqual({
      data: TEMPLATE_REGISTRY["booking.confirmed"].sampleData,
    });
  });

  it("takes the values sent in place of the sample's: groups merge, lists replace with items merged into the sample's first", () => {
    const sample = TEMPLATE_REGISTRY["booking.confirmed"].sampleData;
    const sampleBooking = sample["booking"] as SampleData;

    const prepared = previewData("booking.confirmed", {
      booking: { reference: "VX7K2Q", segments: [{ origin: "LHR" }, { destination: "NCE" }] },
      brand: { name: "Acme Trips" },
    });

    expect(prepared.fieldErrors).toBeUndefined();
    const data = prepared.data as Record<string, Record<string, unknown>>;
    expect(data["brand"]).toEqual({ ...(sample["brand"] as SampleData), name: "Acme Trips" });
    expect(data["documents"]).toEqual(sample["documents"]);
    const [first] = sampleBooking["segments"] as SampleData[];
    expect(data["booking"]).toEqual({
      ...sampleBooking,
      reference: "VX7K2Q",
      segments: [
        { ...first, origin: "LHR" },
        { ...first, destination: "NCE" },
      ],
    });
  });

  it("refuses values outside the allow-list or of the wrong kind with their JSON pointers, never their values", () => {
    const prepared = previewData(
      "booking.confirmed",
      JSON.parse(
        JSON.stringify({
          booking: {
            pnr: "SECRET1",
            reference: { value: "x" },
            segments: [{ origin: ["CDG"] }],
            travellers: "Alex",
            "a/b~c": 1,
          },
          customer: { firstName: "Alex" },
          documents: { attached: "x".repeat(MAX_VARIABLE_LENGTH + 1) },
        }).replace('"customer"', '"__proto__"'),
      ) as unknown,
    );

    expect(prepared.fieldErrors).toEqual([
      {
        path: "/variables/booking/pnr",
        code: "additionalProperties",
        message: "is not a variable of booking.confirmed",
      },
      {
        path: "/variables/booking/reference",
        code: "type",
        message: "must be a string, a number, a boolean or null",
      },
      {
        path: "/variables/booking/segments/0/origin",
        code: "type",
        message: "must be a string, a number, a boolean or null",
      },
      { path: "/variables/booking/travellers", code: "type", message: "must be a list" },
      {
        path: "/variables/booking/a~1b~0c",
        code: "additionalProperties",
        message: "is not a variable of booking.confirmed",
      },
      {
        path: "/variables/__proto__",
        code: "additionalProperties",
        message: "is not a variable of booking.confirmed",
      },
      {
        path: "/variables/documents/attached",
        code: "maxLength",
        message: "must be at most 4000 characters",
      },
    ]);
    expect(JSON.stringify(prepared.fieldErrors)).not.toContain("SECRET1");
    expect(previewData("booking.confirmed", ["x"]).fieldErrors).toEqual([
      { path: "/variables", code: "type", message: "must be an object" },
    ]);
  });
});

describe("console.settings.templates.preview", () => {
  it("renders the stored template with the key's sample data, the HTML escaped and the subject on one line", async () => {
    const { service, audit } = harness();

    const preview = await service.preview(CONFIRMED_EN, undefined);

    expect(checker.check("consolePreviewNotificationTemplate", { status: 200, body: preview })).toEqual([]);
    expect(preview.subject).toBe("Your booking VX7K2M9Q with Demo Travel is confirmed");
    expect(preview.html).toContain("Demo Travel");
    expect(preview.html).not.toContain("{{");
    expect(preview.text).toContain("VX7K2M9Q");
    // A read: no audit row of its own.
    expect(audit).toEqual([]);
  });

  it("renders a draft subject with the variables sent, the other parts from the OTA's row", async () => {
    const { service, templates } = harness();
    templates.add(
      storedRow({
        key: "booking.confirmed",
        locale: "en",
        body_html: "<p>Hello {{booking.contact.firstName}}</p>",
        body_text: "Hello {{booking.contact.firstName}}",
      }),
    );

    const preview = await service.preview(CONFIRMED_EN, {
      subject: "Booked:\n  {{booking.reference}}",
      variables: { booking: { reference: "VX7K2Q", contact: { firstName: "Anna" } } },
    });

    expect(preview).toEqual({ subject: "Booked: VX7K2Q", html: "<p>Hello Anna</p>", text: "Hello Anna" });
  });

  it("never puts a variable's HTML into the HTML part unescaped; the plain-text parts stay plain text", async () => {
    const { service } = harness();

    const preview = await service.preview(CONFIRMED_EN, {
      subject: "{{booking.contact.firstName}}",
      bodyHtml: '<p title="{{booking.reference}}">{{booking.contact.firstName}}</p>',
      bodyText: "{{booking.contact.firstName}}",
      variables: {
        booking: {
          reference: '"><img src=x onerror=alert(1)>',
          contact: { firstName: "<script>alert(1)</script>" },
        },
      },
    });

    expect(preview.html).toBe(
      '<p title="&quot;&gt;&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(preview.subject).toBe("<script>alert(1)</script>");
    expect(preview.text).toBe("<script>alert(1)</script>");
  });

  it("[OBE-073 AC1] refuses a draft that does not compile or uses an unknown variable with 422 TEMPLATE_INVALID", async () => {
    const { service } = harness();

    const error = await refusal(
      service.preview(CONFIRMED_EN, { bodyText: "Line one\n{{booking.pnr}}", bodyHtml: "{{> footer}}" }),
    );

    expect([error.code, error.status]).toEqual(["TEMPLATE_INVALID", 422]);
    expect(error.details).toEqual({
      errors: [
        {
          part: "bodyHtml",
          line: 1,
          message: "PartialStatement is not allowed (partials, decorators and raw blocks are not available)",
        },
        { part: "bodyText", line: 2, message: '"booking.pnr" is not a variable of booking.confirmed' },
      ],
    });
  });

  it("answers 400 VALIDATION_FAILED for variables outside the allow-list", async () => {
    const { service } = harness();

    const error = await refusal(service.preview(CONFIRMED_EN, { variables: { booking: { pnr: "X" } } }));

    expect([error.code, error.fieldErrors]).toEqual([
      "VALIDATION_FAILED",
      [
        {
          path: "/variables/booking/pnr",
          code: "additionalProperties",
          message: "is not a variable of booking.confirmed",
        },
      ],
    ]);
  });
});

describe("the engine's problems in the API's words", () => {
  it("names the parts as the body names them", () => {
    expect(
      templateErrorsOf([
        { part: "subject", line: 1, message: "a" },
        { part: "html", line: null, message: "b" },
        { part: "txt", line: 3, message: "c" },
      ]),
    ).toEqual([
      { part: "subject", line: 1, message: "a" },
      { part: "bodyHtml", line: null, message: "b" },
      { part: "bodyText", line: 3, message: "c" },
    ]);
  });

  it("names a strict-mode render failure by its variable and line, never a value of the data", () => {
    const compiled = compileTemplate({
      key: "booking.confirmed",
      origin: "tenant",
      locale: "en",
      templateId: null,
      version: 1,
      sources: { subject: "S", html: null, text: "Hello\n{{booking.contact.firstName}}" },
    });

    const error = (() => {
      try {
        compiled.render({ booking: { contact: { lastName: "Secretname" } } });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(TemplateRenderError);
    const failure = renderErrorOf(error as TemplateRenderError);
    expect(failure).toEqual({
      part: "bodyText",
      line: 2,
      message: '"firstName" has no value in the render data',
    });
    expect(JSON.stringify(failure)).not.toContain("Secretname");
  });
});

/* ------------------------------------------------------------------------------------------------
 * reset
 * ---------------------------------------------------------------------------------------------- */

describe("console.settings.templates.reset", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("deletes the OTA's row and answers the code default, recording the deleted template", async () => {
    // A row seeded from the code default (`is_system`) is reset as any other (FIX-W33-OTA).
    const row = h.templates.add(storedRow({ key: "booking.confirmed", locale: "en", version: 2 }));

    const answer = await h.service.reset(CONFIRMED_EN);

    expect(checker.check("consoleResetNotificationTemplate", { status: 200, body: answer })).toEqual([]);
    expect(answer).toMatchObject({ locale: "en", customised: false, version: null, updatedAt: null });
    expect(h.templates.rows.size).toBe(0);
    expect(h.audit).toEqual([
      {
        action: "settings.templates.reset",
        targetType: "notification_template",
        targetId: templateTargetId(CONFIRMED_EN),
        before: expect.objectContaining({ id: row.id, version: 2, subject: row.subject }) as unknown,
        after: null,
      },
    ]);
  });

  it("changes nothing without a row and still answers the default (safe to repeat)", async () => {
    const answer = await h.service.reset({ ...CONFIRMED_EN, locale: "fr" });

    expect(answer).toMatchObject({ locale: "fr", customised: false, inheritedFrom: null });
    expect(h.audit).toMatchObject([{ action: "settings.templates.reset", before: null, after: null }]);
  });

  it("[FIX-W33-OTA] [OBE-073] deletes the locale's own row only and answers the language's row that e-mails use from then on", async () => {
    const language = h.templates.add(
      storedRow({
        key: "booking.confirmed",
        locale: "en",
        subject: "Booked {{booking.reference}}!",
        is_system: false,
      }),
    );
    h.templates.add(storedRow({ key: "booking.confirmed", locale: "en-GB", is_system: false, version: 5 }));

    const answer = await h.service.reset({ ...CONFIRMED_EN, locale: "en-GB" });

    expect(checker.check("consoleResetNotificationTemplate", { status: 200, body: answer })).toEqual([]);
    expect(answer).toMatchObject({
      locale: "en-GB",
      inheritedFrom: "en",
      subject: language.subject,
      customised: true,
      version: null,
    });
    expect([...h.templates.rows.values()]).toEqual([language]);
  });
});
