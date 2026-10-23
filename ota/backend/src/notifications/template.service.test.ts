// The templates of the OTA's e-mails without PostgreSQL or SMTP (OBE-030; OADR-0013 item 3, ADR-0017 "Templates"):
// which template applies (a repository double answers the tenant's active rows as the SQL does), the safe Handlebars
// subset and the allow-list check, strict-mode rendering and escaping, the render data of the renderer (brand, links,
// payload) and the two shipped defaults, auth.verify_email and auth.password_reset. The same paths run against
// PostgreSQL, Redis and Mailpit in test/integration/notifications/outbox.int.test.ts. Since OBE-055 every key has a
// shipped default (templates/templates.test.ts checks the booking and staff ones), so the tests of a key without one
// read the defaults from a folder that holds the account e-mails' only (`accountDefaultsDir`).
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { SharedConfig } from "../config";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { NotificationTemplateRow, OutboxRepository, SenderSettings } from "./outbox.repository";
import {
  checkSecretData,
  checkTemplateData,
  NotificationDataError,
  NotificationRenderer,
  renderData,
  storefrontUrl,
  type BrandValues,
} from "./renderer";
import {
  checkTemplate,
  compileTemplate,
  TemplateInvalidError,
  TemplateMissingError,
  TemplateRenderError,
  templateLocales,
  TemplateService,
  type EffectiveTemplate,
} from "./template.service";
import {
  callerVariables,
  DEFAULT_TEMPLATES_DIR,
  TEMPLATE_REGISTRY,
  TemplateFilesError,
  type TemplateKey,
} from "./templates/registry";

/** Nothing reaches a database here: the repository double never uses the transaction. */
const TRX = {} as TenantTransaction;

const BRAND: BrandValues = {
  name: "Alpha Travel",
  supportEmail: "help@alpha-travel.example",
  supportPhone: "+44 20 7946 0000",
  storefrontUrl: storefrontUrl("alpha", "ota.example.com"),
};

/** A token as the auth flows make them: 43 characters of base64url. Generated per test file, never a real one. */
const TOKEN = "tOk3n_-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";

let rowCounter = 0;

/** A tenant row of `notification_templates`. */
function templateRow(
  overrides: Partial<NotificationTemplateRow> & { key: string; locale: string },
): NotificationTemplateRow {
  rowCounter += 1;
  return {
    id: `ntt_01J9ZA2B4C6D8E0F2G4H6J8K${String(rowCounter).padStart(2, "0")}`,
    channel: "email",
    subject: "Tenant subject {{brand.name}}",
    body_html: "<p>Tenant {{customer.firstName}}</p>",
    body_text: "Tenant {{customer.firstName}}",
    sample_data: {},
    is_system: false,
    is_active: true,
    version: 1,
    created_at: new Date("2026-10-01T10:00:00Z"),
    updated_at: new Date("2026-10-01T10:00:00Z"),
    ...overrides,
  };
}

/** The repository as far as the template service reads it: the active rows of a key in the given locales. */
function repositoryWith(rows: readonly NotificationTemplateRow[], sender?: SenderSettings): OutboxRepository {
  return {
    activeTemplates: vi.fn((_trx: unknown, key: string, channel: string, locales: readonly string[]) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.key === key && row.channel === channel && locales.includes(row.locale) && row.is_active,
        ),
      ),
    ),
    senderSettings: vi.fn(() => Promise.resolve(sender)),
  } as unknown as OutboxRepository;
}

/** A tenant template of `key` with the given sources. */
function tenantTemplate(
  key: TemplateKey,
  sources: { subject?: string; html?: string | null; text?: string },
): EffectiveTemplate {
  return {
    key,
    origin: "tenant",
    locale: "en",
    templateId: "ntt_01J9ZA2B4C6D8E0F2G4H6J8KZZ",
    version: 3,
    sources: {
      subject: sources.subject ?? "Hello",
      html: sources.html === undefined ? "<p>Hello</p>" : sources.html,
      text: sources.text ?? "Hello",
    },
  };
}

/** The render data of an auth.verify_email e-mail to Alex, with the secret token. */
function verifyData(): Record<string, unknown> {
  return renderData("auth.verify_email", {
    brand: BRAND,
    payload: { customer: { firstName: "Alex" }, expiresAt: "2026-11-02T10:00:00Z" },
    secrets: { token: TOKEN },
  });
}

function silentLogger(): PinoLogger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
}

const config = { get: () => "ota.example.com" } as unknown as ConfigService<SharedConfig, true>;

/**
 * A new folder with the shipped defaults of the account e-mails only (auth.verify_email, auth.password_reset): the
 * booking and staff keys have no default files there. The caller removes it.
 */
function accountDefaultsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "obe030-defaults-"));
  cpSync(DEFAULT_TEMPLATES_DIR, dir, {
    recursive: true,
    filter: (path) => path === DEFAULT_TEMPLATES_DIR || /[\\/]auth\.[a-z_]+\.[a-z]+\.hbs$/.test(path),
  });
  return dir;
}

describe("the effective template", () => {
  it("[OBE-030 AC3] is the tenant's active row for the e-mail's locale", async () => {
    const row = templateRow({ key: "auth.verify_email", locale: "en-GB" });
    const service = new TemplateService(
      repositoryWith([templateRow({ key: "auth.verify_email", locale: "en" }), row]),
    );

    const template = await service.effective(TRX, "auth.verify_email", "en-GB");

    expect(template).toMatchObject({ origin: "tenant", locale: "en-GB", templateId: row.id, version: 1 });
    expect(template.sources.subject).toBe(row.subject);
  });

  it("is the tenant's row for the locale's language when the locale has none (the seeded en rows serve en-GB)", async () => {
    const row = templateRow({ key: "auth.verify_email", locale: "en" });
    const service = new TemplateService(repositoryWith([row]));

    expect(await service.effective(TRX, "auth.verify_email", "en-GB")).toMatchObject({
      origin: "tenant",
      templateId: row.id,
    });
    expect(templateLocales("en-GB")).toEqual(["en-GB", "en"]);
    expect(templateLocales("fr")).toEqual(["fr"]);
  });

  it("[OBE-030 AC3] is the code default when the tenant's row is inactive", async () => {
    const inactive = templateRow({ key: "auth.verify_email", locale: "en", is_active: false });
    const repository = repositoryWith([inactive]);
    const service = new TemplateService(repository);

    const template = await service.effective(TRX, "auth.verify_email", "en");

    expect(template).toMatchObject({ origin: "default", locale: "en", templateId: null, version: 0 });
    expect(template.sources.subject).toBe("Confirm your e-mail address for {{brand.name}}");
    expect(repository.activeTemplates).toHaveBeenCalledWith(TRX, "auth.verify_email", "email", ["en"]);
  });

  it("is the English code default for a locale that has neither a tenant row nor a default", async () => {
    const service = new TemplateService(
      repositoryWith([templateRow({ key: "auth.verify_email", locale: "de" })]),
    );

    expect(await service.effective(TRX, "auth.verify_email", "fr-FR")).toMatchObject({
      origin: "default",
      locale: "en",
    });
  });

  it("does not exist for a key with neither a tenant row nor default files", async () => {
    const dir = accountDefaultsDir();
    try {
      const service = new TemplateService(repositoryWith([]), dir);

      await expect(service.effective(TRX, "booking.confirmed", "en")).rejects.toBeInstanceOf(
        TemplateMissingError,
      );
      expect(await service.codeDefault("booking.confirmed")).toBeUndefined();
      expect(await service.codeDefault("auth.verify_email")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads and compiles a code default once", async () => {
    const service = new TemplateService(repositoryWith([]));

    const first = await service.codeDefault("auth.password_reset");
    const second = await service.codeDefault("auth.password_reset");

    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe("the template check", () => {
  it("[OBE-030 AC3] refuses a tenant template that uses a variable outside the allow-list, with a clear error", async () => {
    const service = new TemplateService(repositoryWith([]));
    const template = tenantTemplate("auth.verify_email", {
      subject: "Welcome {{customer.firstName}}",
      text: "Hello {{customer.firstName}} {{customer.lastName}},\nyour password: {{customer.password}}",
    });

    const error = await service.render(template, verifyData()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemplateInvalidError);
    const invalid = error as TemplateInvalidError;
    expect(invalid.problems).toEqual([
      { part: "txt", line: 1, message: '"customer.lastName" is not a variable of auth.verify_email' },
      { part: "txt", line: 2, message: '"customer.password" is not a variable of auth.verify_email' },
    ]);
    expect(invalid.message).toContain(
      'The tenant template auth.verify_email (en) is invalid: txt line 1: "customer.lastName" is not a variable of auth.verify_email',
    );
    // The message lists the variables the key allows, so the OTA (or the console's 422) can fix the template.
    expect(invalid.message).toContain("customer.firstName, verifyUrl, expiresAt");
    expect(invalid.message).not.toContain("Alex");
  });

  it("accepts the subset: variables, if/unless/else, each over a list with ../ to the outer level, comments", () => {
    const source = [
      "{{! booking summary }}",
      "{{#if booking.recordLocator}}PNR {{booking.recordLocator}}{{else}}No PNR yet{{/if}}",
      "{{#unless brand.supportPhone}}No phone{{/unless}}",
      "{{#each booking.segments}}{{origin}}-{{this.destination}} with {{../brand.name}}{{else}}none{{/each}}",
      "{{#if booking.travellers}}{{#each booking.travellers}}{{firstName}}{{/each}}{{/if}}",
      "{{~booking.reference~}}",
    ].join("\n");

    expect(checkTemplate("booking.confirmed", "html", source)).toEqual([]);
  });

  it("refuses what could turn escaping off, run code or reach data the key does not allow, every problem at once", () => {
    const source = [
      "{{{customer.firstName}}}",
      "{{lookup customer 'firstName'}}",
      "{{log customer}}",
      "{{> footer}}",
      "{{#with customer}}{{firstName}}{{/with}}",
      "{{#if (eq customer.firstName 'x')}}x{{/if}}",
      "{{@root.customer.firstName}}",
      "{{customer}}",
      "{{#each customer}}x{{/each}}",
      "{{../customer.firstName}}",
      "{{this}}",
      '{{"literal"}}',
      "{{#each booking.segments as |segment|}}x{{/each}}",
    ].join("\n");

    const problems = checkTemplate("auth.verify_email", "html", source);

    expect(problems.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(problems.map((problem) => problem.message)).toEqual([
      "triple braces would turn HTML escaping off: use {{variable}}",
      "helpers are not available: use {{variable}}, {{#if}}, {{#unless}} or {{#each}}",
      "helpers are not available: use {{variable}}, {{#if}}, {{#unless}} or {{#each}}",
      "PartialStatement is not allowed (partials, decorators and raw blocks are not available)",
      "{{#with}} is not available: use {{#if}}, {{#unless}} or {{#each}}",
      "SubExpression is not allowed: name a variable",
      '"@root.customer.firstName": @ variables are not available',
      '"customer" is a group of variables, not a value: name one of its variables',
      '"customer" is not a list of auth.verify_email: {{#each}} needs one',
      '"../customer.firstName" goes above the top level with ../',
      '"this" is only available inside {{#each}}',
      "StringLiteral is not allowed: name a variable",
      "{{#each}} block parameters (as |…|) are not available",
    ]);
  });

  it("refuses a link variable in the subject: the subject is stored after the secrets are erased", () => {
    expect(checkTemplate("auth.verify_email", "subject", "Open {{verifyUrl}}")).toEqual([
      {
        part: "subject",
        line: 1,
        message: '"verifyUrl" holds a secret link and may not appear in the subject',
      },
    ]);
    expect(checkTemplate("auth.verify_email", "txt", "Open {{verifyUrl}}")).toEqual([]);
  });

  it("refuses a template that does not parse, with the line of the error", () => {
    const problems = checkTemplate("auth.verify_email", "txt", "Hello\n{{#if customer.firstName}}\nno end");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ part: "txt", line: 3 });
    expect(problems[0]?.message).toMatch(/^does not parse/);
  });

  it("names the code default in the error of a default that breaks a rule (a bug, never the OTA's)", () => {
    const template: EffectiveTemplate = {
      ...tenantTemplate("auth.verify_email", { text: "{{nope}}" }),
      origin: "default",
    };

    expect(() => compileTemplate(template)).toThrow(
      /^The code default template auth\.verify_email \(en\) is invalid/,
    );
  });
});

describe("rendering", () => {
  it("runs in strict mode: a variable missing from the data fails instead of rendering empty", () => {
    const compiled = compileTemplate(
      tenantTemplate("auth.verify_email", { text: "Hello {{customer.firstName}}" }),
    );

    expect(() => compiled.render({ brand: BRAND })).toThrow(TemplateRenderError);
    expect(() => compiled.render({ brand: BRAND })).toThrow(/failed to render its txt/);
  });

  it("escapes the HTML part only, and collapses the subject to one line", () => {
    const compiled = compileTemplate(
      tenantTemplate("auth.verify_email", {
        subject: "Hi\n  {{customer.firstName}}\n",
        html: "<p>{{customer.firstName}}</p>",
        text: "{{customer.firstName}} {{verifyUrl}}",
      }),
    );
    const data = renderData("auth.verify_email", {
      brand: BRAND,
      payload: { customer: { firstName: "<b>Al & Co</b>" }, expiresAt: "2026-11-02T10:00:00Z" },
      secrets: { token: "a&b=c" },
    });

    const rendered = compiled.render(data);

    expect(rendered.subject).toBe("Hi <b>Al & Co</b>");
    expect(rendered.html).toBe("<p>&lt;b&gt;Al &amp; Co&lt;/b&gt;</p>");
    expect(rendered.text).toBe(
      "<b>Al & Co</b> https://alpha.ota.example.com/account/verify.html?token=a%26b%3Dc",
    );
  });

  it("sends a template without an HTML part as text only", () => {
    const rendered = compileTemplate(tenantTemplate("auth.verify_email", { html: null, text: "Hi" })).render(
      verifyData(),
    );

    expect(rendered.html).toBeNull();
    expect(rendered.text).toBe("Hi");
  });
});

describe("the shipped defaults (OBE-030 step 5)", () => {
  it("auth.verify_email links to /account/verify.html?token=… on the tenant's storefront host", async () => {
    const service = new TemplateService(repositoryWith([]));
    const template = await service.effective(TRX, "auth.verify_email", "en");

    const rendered = await service.render(template, verifyData());

    const link = `https://alpha.ota.example.com/account/verify.html?token=${TOKEN}`;
    expect(rendered.subject).toBe("Confirm your e-mail address for Alpha Travel");
    expect(rendered.text).toContain(`\n${link}\n`);
    expect(rendered.text).toContain("Hello Alex,");
    expect(rendered.text).toContain("valid until 2026-11-02T10:00:00Z (UTC)");
    expect(rendered.text).toContain(
      "Questions? Write to help@alpha-travel.example or call +44 20 7946 0000.",
    );
    // Handlebars escapes `=` in the HTML part; a mail client decodes the entity in the attribute.
    expect(rendered.html).toContain(`href="${link.replace("=", "&#x3D;")}"`);
    expect(rendered.html).not.toContain("{{");
  });

  it("auth.password_reset links to /account/reset-password.html?token=… on the tenant's storefront host", async () => {
    const service = new TemplateService(repositoryWith([]));
    const template = await service.effective(TRX, "auth.password_reset", "en-GB");
    const data = renderData("auth.password_reset", {
      brand: { ...BRAND, supportEmail: "", supportPhone: "" },
      payload: { customer: { firstName: "" }, expiresAt: "2026-11-01T11:00:00Z" },
      secrets: { token: TOKEN },
    });

    const rendered = await service.render(template, data);

    expect(rendered.subject).toBe("Reset your Alpha Travel password");
    expect(rendered.text).toContain(
      `https://alpha.ota.example.com/account/reset-password.html?token=${TOKEN}`,
    );
    // Without a first name or support details the e-mail says less, never an empty "Hello ,".
    expect(rendered.text.startsWith("Hello,\n")).toBe(true);
    expect(rendered.text).not.toContain("Questions?");
    expect(rendered.html).not.toContain("mailto:");
  });

  it("both render with the registry's sample data, and use only their own allow-list", async () => {
    const service = new TemplateService(repositoryWith([]));
    for (const key of ["auth.verify_email", "auth.password_reset"] as const) {
      const compiled = await service.codeDefault(key);
      const rendered = compiled?.render(TEMPLATE_REGISTRY[key].sampleData);

      expect(rendered?.subject, key).toContain("Demo Travel");
      expect(rendered?.text, key).toContain("https://demo.ota.example.com/account/");
    }
  });
});

describe("the render data", () => {
  it("[OBE-030 AC3] is checked when an e-mail is queued: exactly the caller variables, every one present", () => {
    expect(callerVariables("auth.verify_email").map((entry) => entry.name)).toEqual([
      "customer.firstName",
      "expiresAt",
    ]);
    expect(
      checkTemplateData("auth.verify_email", { customer: { firstName: "Alex" }, expiresAt: "x" }),
    ).toEqual([]);
    expect(
      checkTemplateData("auth.verify_email", {
        customer: { firstName: "Alex", lastName: "Martin" },
        verifyUrl: "https://elsewhere.example.com",
      }),
    ).toEqual([
      "verifyUrl is not a variable of the template",
      "customer.lastName is not a variable of the template",
      "expiresAt is missing",
    ]);
    expect(checkTemplateData("auth.verify_email", { customer: "Alex", expiresAt: { at: 1 } })).toEqual([
      "customer must be an object",
      "expiresAt must be a string of at most 4000 characters, a number, a boolean or null",
    ]);
    expect(checkTemplateData("auth.verify_email", ["Alex"])).toEqual(["the data must be an object"]);
  });

  it("checks lists item by item (booking keys)", () => {
    const booking = TEMPLATE_REGISTRY["booking.confirmed"].sampleData["booking"] as Record<string, unknown>;

    expect(checkTemplateData("booking.confirmed", { booking })).toEqual([]);
    expect(
      checkTemplateData("booking.confirmed", {
        booking: { ...booking, segments: [{ origin: "CDG" }, { origin: "JFK", gate: "A1" }] },
      }),
    ).toContain("booking.segments[].destination is missing");
    expect(checkTemplateData("booking.confirmed", { booking: { ...booking, travellers: {} } })).toContain(
      "booking.travellers must be a list",
    );
  });

  it("requires exactly the key's secret values", () => {
    expect(checkSecretData("auth.verify_email", { token: TOKEN })).toEqual([]);
    expect(checkSecretData("auth.verify_email", undefined)).toEqual(["the secret values token are required"]);
    expect(checkSecretData("auth.verify_email", { token: "", other: "x" })).toEqual([
      "other is not a secret value of auth.verify_email",
      "the secret value token must be a string of 1 to 512 characters",
    ]);
    expect(checkSecretData("booking.confirmed", undefined)).toEqual([]);
    expect(checkSecretData("booking.confirmed", { token: TOKEN })).toEqual([
      "token is not a secret value of booking.confirmed",
    ]);
  });

  it("holds only allow-listed paths of the payload, the brand and the links built from the secrets", () => {
    const data = renderData("auth.verify_email", {
      brand: BRAND,
      payload: { customer: { firstName: "Alex", lastName: "Martin" }, expiresAt: "x", extra: "dropped" },
      secrets: { token: TOKEN },
    });

    expect(data).toEqual({
      customer: { firstName: "Alex" },
      expiresAt: "x",
      brand: BRAND,
      verifyUrl: `https://alpha.ota.example.com/account/verify.html?token=${TOKEN}`,
    });
    expect(() =>
      renderData("auth.verify_email", {
        brand: BRAND,
        payload: { customer: { firstName: "A" } },
        secrets: {},
      }),
    ).toThrow(NotificationDataError);
  });
});

describe("the renderer", () => {
  const tenant = { key: "alpha", name: "Alpha (platform name)" };
  const row = (key: string, locale = "en") => ({
    id: "ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M",
    template_key: key,
    locale,
    payload: { customer: { firstName: "Alex" }, expiresAt: "2026-11-02T10:00:00Z" },
  });

  it("renders with the tenant's sender settings, or its platform name before the settings exist", async () => {
    const sender = {
      brandName: "Alpha Travel",
      supportEmail: "help@alpha-travel.example",
      supportPhone: null,
    };
    const repository = repositoryWith([], sender);
    const renderer = new NotificationRenderer(
      new TemplateService(repository),
      repository,
      silentLogger(),
      config,
    );

    const batch = await renderer.prepare(TRX, tenant, [row("auth.verify_email")]);
    const rendered = await batch.render(row("auth.verify_email"), { token: TOKEN });

    expect(batch.brand).toEqual({
      name: "Alpha Travel",
      supportEmail: "help@alpha-travel.example",
      supportPhone: "",
      storefrontUrl: "https://alpha.ota.example.com",
    });
    expect(rendered).toMatchObject({ origin: "default", templateId: null });
    expect(rendered.subject).toBe("Confirm your e-mail address for Alpha Travel");
    expect(renderer.brand(tenant, undefined).name).toBe("Alpha (platform name)");
  });

  it("falls back to the code default when the tenant's template is invalid, and logs why without the data", async () => {
    const broken = templateRow({
      key: "auth.verify_email",
      locale: "en",
      body_text: "{{customer.lastName}}",
    });
    const repository = repositoryWith([broken]);
    const logger = silentLogger();
    const renderer = new NotificationRenderer(new TemplateService(repository), repository, logger, config);

    const batch = await renderer.prepare(TRX, tenant, [row("auth.verify_email")]);
    const rendered = await batch.render(row("auth.verify_email"), { token: TOKEN });

    expect(rendered).toMatchObject({ origin: "default", templateId: null });
    expect(rendered.text).toContain(`token=${TOKEN}`);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        template: "auth.verify_email",
        templateId: broken.id,
        reason: expect.stringContaining(
          '"customer.lastName" is not a variable of auth.verify_email',
        ) as unknown,
      }),
      "notifications.template_fallback",
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("Alex");
  });

  it("fails only the rows of a key whose code default is broken (a bug of a release), and renders the others of the batch", async () => {
    // The shipped defaults of the account e-mails, and two broken ones: booking.confirmed uses a variable outside its
    // allow-list, booking.cancelled has its subject file only.
    const dir = accountDefaultsDir();
    try {
      writeFileSync(join(dir, "booking.confirmed.subject.hbs"), "Booking {{booking.reference}}");
      writeFileSync(join(dir, "booking.confirmed.html.hbs"), "<p>{{booking.nope}}</p>");
      writeFileSync(join(dir, "booking.confirmed.txt.hbs"), "{{booking.reference}}");
      writeFileSync(join(dir, "booking.cancelled.subject.hbs"), "Booking {{booking.reference}} cancelled");
      const repository = repositoryWith([]);
      const renderer = new NotificationRenderer(
        new TemplateService(repository, dir),
        repository,
        silentLogger(),
        config,
      );

      const batch = await renderer.prepare(TRX, tenant, [
        row("booking.confirmed"),
        row("booking.cancelled"),
        row("auth.verify_email"),
      ]);

      await expect(batch.render(row("booking.confirmed"), {})).rejects.toThrow(
        /^The code default template booking\.confirmed \(en\) is invalid: html line 1: "booking\.nope"/,
      );
      await expect(batch.render(row("booking.cancelled"), {})).rejects.toBeInstanceOf(TemplateFilesError);
      await expect(batch.render(row("auth.verify_email"), { token: TOKEN })).resolves.toMatchObject({
        origin: "default",
        subject: "Confirm your e-mail address for Alpha (platform name)",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a row whose key has no template, or that lacks its secret, without failing the batch", async () => {
    const dir = accountDefaultsDir();
    try {
      const repository = repositoryWith([]);
      const renderer = new NotificationRenderer(
        new TemplateService(repository, dir),
        repository,
        silentLogger(),
        config,
      );

      const batch = await renderer.prepare(TRX, tenant, [row("booking.confirmed"), row("auth.verify_email")]);

      await expect(batch.render(row("booking.confirmed"), {})).rejects.toBeInstanceOf(TemplateMissingError);
      await expect(batch.render(row("auth.verify_email"), {})).rejects.toBeInstanceOf(NotificationDataError);
      await expect(batch.render(row("auth.unknown"), {})).rejects.toBeInstanceOf(NotificationDataError);
      await expect(batch.render(row("auth.verify_email"), { token: TOKEN })).resolves.toMatchObject({
        origin: "default",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
