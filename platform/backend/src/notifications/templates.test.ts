// The platform's e-mail templates (PBE-011; PADR-0013 item 5, ADR-0017): every template renders with sample data in
// strict mode, names only the variables of its allow-list, escapes HTML in its HTML part only, and the build ships the
// folder. The samples are the fixtures of PADR-0013 item 5 ("each with subject, HTML and text, and a fixture test").
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACT_CENSOR, REDACT_PATHS, redactPayload } from "@velexis/logger";
import Handlebars from "handlebars";
import { afterEach, describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import {
  BUILT_IN_VARIABLES,
  checkEmailVariables,
  compileTemplatePart,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATES,
  EmailTemplateError,
  EmailTemplates,
  EmailVariablesError,
  isLinkVariable,
  MAX_VARIABLE_LENGTH,
  TEMPLATE_PARTS,
  templateFileName,
  templateVariables,
  TEMPLATES_DIR,
  type BuiltInVariables,
  type EmailTemplateKey,
  type EmailVariables,
} from "./templates";

const BUILT_INS: BuiltInVariables = {
  portalUrl: "https://platform.example.com",
  adminUrl: "https://admin.platform.example.com",
};

/** Sample data of every template (test values only; the tokens are made up). */
const SAMPLES: Readonly<Record<EmailTemplateKey, EmailVariables>> = {
  "auth.verify_email": {
    data: { fullName: "Ana Lima" },
    secretData: { verifyUrl: "https://platform.example.com/verify-email?token=sample-verify-token" },
  },
  "auth.account_exists": {
    data: { fullName: "Ana Lima" },
    secretData: { resetUrl: "https://platform.example.com/reset-password?token=sample-reset-token" },
  },
  "auth.password_reset": {
    data: { fullName: "Ana Lima" },
    secretData: { resetUrl: "https://platform.example.com/reset-password?token=sample-reset-token" },
  },
  "auth.password_changed": { data: { fullName: "Ana Lima" }, secretData: {} },
  "auth.mfa_changed": { data: { fullName: "Ana Lima", change: "it was turned on" }, secretData: {} },
  "team.invitation": {
    data: { tenantName: "Acme Travel", inviterName: "Lena Holm", role: "admin" },
    secretData: {
      acceptUrl: "https://platform.example.com/invitations/accept?token=sample-invitation-token",
    },
  },
  "tenant.welcome": {
    data: { fullName: "Ana Lima", tenantName: "Acme Travel", tenantKey: "acme" },
    secretData: {},
  },
  "tenant.provisioning_failed": {
    data: { fullName: "Ana Lima", tenantName: "Acme Travel", tenantKey: "acme" },
    secretData: {},
  },
  "tenant.suspended": {
    data: { fullName: "Ana Lima", tenantName: "Acme Travel", tenantKey: "acme" },
    secretData: {},
  },
  "tenant.resumed": {
    data: { fullName: "Ana Lima", tenantName: "Acme Travel", tenantKey: "acme" },
    secretData: {},
  },
  "ops.alert": {
    data: {
      title: "Fewer than 3 test offices are available",
      message: "2 test offices are available.\nAdd offices.",
    },
    secretData: {},
  },
  "payouts.reviewed": {
    data: {
      fullName: "Ana Lima",
      tenantName: "Acme Travel",
      tenantKey: "acme",
      outcome: "verified",
      nextStep: "Velexis can now pay your monthly settlements to this account.",
      payoutAccountUrl:
        "https://platform.example.com/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/payments/payout-account",
    },
    secretData: {},
  },
  "settlement.paid": {
    data: {
      fullName: "Ana Lima",
      tenantName: "Acme Travel",
      tenantKey: "acme",
      period: "January 2027",
      netAmount: "8935.10 EUR",
      paidOn: "2027-02-07",
      payoutReference: "VX-SETTLE-2027-01-ACME",
      statementUrl:
        "https://platform.example.com/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/payments/settlements/stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q",
    },
    secretData: {},
  },
  "connection.stripe_disconnected": {
    data: {
      fullName: "Ana Lima",
      tenantName: "Acme Travel",
      tenantKey: "acme",
      paymentsUrl: "https://platform.example.com/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/payments",
    },
    secretData: {},
  },
  "connection.credentials_applied": {
    data: {
      fullName: "Ana Lima",
      tenantName: "Acme Travel",
      tenantKey: "acme",
      credentials: "Amadeus credentials",
      environment: "live",
      connectionUrl: "https://platform.example.com/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/amadeus",
    },
    secretData: {},
  },
  "connection.credentials_failed": {
    data: {
      fullName: "Ana Lima",
      tenantName: "Acme Travel",
      tenantKey: "acme",
      credentials: "Stripe API keys",
      environment: "test",
      errorCode: "STRIPE_KEY_INVALID",
      reason: "Stripe answered 401 (api_key_invalid).",
      connectionUrl: "https://platform.example.com/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F/payments",
    },
    secretData: {},
  },
};

const templates = EmailTemplates.load();

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the template folder in a temporary directory, to break on purpose. */
function templatesCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "velexis-email-templates-"));
  scratch.push(dir);
  cpSync(TEMPLATES_DIR, dir, { recursive: true });
  return dir;
}

function loadError(dir: string): EmailTemplateError {
  try {
    EmailTemplates.load(dir);
  } catch (error) {
    if (error instanceof EmailTemplateError) {
      return error;
    }
    throw error;
  }
  throw new Error("EmailTemplates.load accepted the folder");
}

describe("e-mail templates", () => {
  it("[PBE-011 AC4] are the M1 templates of PADR-0013 and the M5 ones, with a key the email_outbox CHECK accepts", () => {
    expect([...EMAIL_TEMPLATE_KEYS].sort()).toEqual(
      [
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
        // M5: the payout account review (PBE-058) and the paid settlement (PBE-060).
        "payouts.reviewed",
        "settlement.paid",
        // M5: a Connect deauthorisation (PBE-056).
        "connection.stripe_disconnected",
        // M5: the end of a credential verification (PBE-052).
        "connection.credentials_applied",
        "connection.credentials_failed",
      ].sort(),
    );
    for (const key of EMAIL_TEMPLATE_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_.]{2,63}$/);
    }
  });

  it.each(EMAIL_TEMPLATE_KEYS)("[PBE-011 AC4] %s renders with sample data in strict mode", (key) => {
    const sample = SAMPLES[key];

    const rendered = templates.render(key, sample, BUILT_INS);

    expect(rendered.subject).not.toBe("");
    expect(rendered.subject).not.toMatch(/[\r\n]|\{\{|\}\}|^\s|\s$/);
    expect(rendered.html.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true);
    expect(rendered.html).toContain("The Velexis team");
    expect(rendered.text).toContain("The Velexis team");
    for (const part of [rendered.subject, rendered.html, rendered.text]) {
      expect(part).not.toMatch(/\{\{|\}\}/);
    }
    // Every link of the template is in both bodies: the HTML one as an <a href>, the text one as written.
    for (const [name, value] of Object.entries(sample.secretData)) {
      expect(isLinkVariable(name), name).toBe(true);
      expect(rendered.text).toContain(value as string);
      expect(rendered.html).toContain(`href="${Handlebars.escapeExpression(value as string)}"`);
    }
  });

  it.each(EMAIL_TEMPLATE_KEYS)(
    "%s names only its allow-list and the built-ins, and uses every variable",
    (key) => {
      const definition = EMAIL_TEMPLATES[key];
      const used = new Set<string>();
      for (const part of TEMPLATE_PARTS) {
        const file = templateFileName(key, part);
        for (const name of templateVariables(readFileSync(join(TEMPLATES_DIR, file), "utf8"), file)) {
          used.add(name);
        }
      }
      const allowed = [...BUILT_IN_VARIABLES, ...definition.variables, ...definition.secretVariables];

      expect([...used].filter((name) => !allowed.includes(name))).toEqual([]);
      expect(
        [...definition.variables, ...definition.secretVariables].filter((name) => !used.has(name)),
      ).toEqual([]);
      // Secret variables are links and never stored in clear; the two lists never share a name.
      expect(definition.secretVariables.every(isLinkVariable)).toBe(true);
      expect(definition.variables.filter((name) => definition.secretVariables.includes(name))).toEqual([]);
    },
  );

  it("puts every secret variable on the redaction list of @velexis/logger (conventions §7)", () => {
    const secretVariables = [
      ...new Set(EMAIL_TEMPLATE_KEYS.flatMap((key) => EMAIL_TEMPLATES[key].secretVariables)),
    ];

    expect(secretVariables).toEqual(expect.arrayContaining(["acceptUrl", "resetUrl", "verifyUrl"]));
    for (const name of ["secretData", ...secretVariables]) {
      // In log lines at the top level and one level down; in persisted payload copies at any depth.
      expect(REDACT_PATHS, name).toEqual(expect.arrayContaining([name, `*.${name}`]));
      expect(redactPayload({ email: { [name]: "https://platform.example.com/x?token=t" } })).toEqual({
        email: { [name]: REDACT_CENSOR },
      });
    }
  });

  it("holds exactly the subject, HTML and text files of every template", () => {
    const expected = EMAIL_TEMPLATE_KEYS.flatMap((key) =>
      TEMPLATE_PARTS.map((part) => templateFileName(key, part)),
    );

    expect(readdirSync(TEMPLATES_DIR).sort()).toEqual(expected.sort());
  });

  it("escapes HTML in the HTML part only, and keeps the subject on one line", () => {
    const rendered = templates.render(
      "team.invitation",
      {
        data: {
          tenantName: 'Acme <script>alert("x")</script> & Co',
          inviterName: "Lena\r\nBcc: x",
          role: "admin",
        },
        secretData: { acceptUrl: "https://platform.example.com/invitations/accept?token=a&b=c" },
      },
      BUILT_INS,
    );

    expect(rendered.html).toContain("Acme &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain(
      'href="https://platform.example.com/invitations/accept?token&#x3D;a&amp;b&#x3D;c"',
    );
    expect(rendered.text).toContain("https://platform.example.com/invitations/accept?token=a&b=c");
    expect(rendered.text).toContain('Acme <script>alert("x")</script> & Co');
    expect(rendered.subject).toBe(
      'Lena Bcc: x invited you to Acme <script>alert("x")</script> & Co on Velexis',
    );
  });

  it("[PBE-011 AC4] throws in strict mode on a variable missing from the context, never rendering it empty", () => {
    for (const part of TEMPLATE_PARTS) {
      const render = compileTemplatePart(Handlebars.create(), "Hello {{fullName}}", part);

      expect(render({ fullName: "Ana" })).toBe("Hello Ana");
      expect(() => render({})).toThrow(/"fullName" not defined/);
    }
  });

  it("refuses variables outside the allow-list, missing ones, and values that are not short strings, by name only", () => {
    const cases: Array<[EmailVariables, RegExp]> = [
      [
        {
          data: { fullName: "Ana", extra: "secret-value-1" },
          secretData: SAMPLES["auth.verify_email"].secretData,
        },
        /extra/,
      ],
      [{ data: {}, secretData: SAMPLES["auth.verify_email"].secretData }, /lacks the variables fullName/],
      [{ data: { fullName: "Ana" }, secretData: {} }, /secretData lacks the variables verifyUrl/],
      [
        { data: { fullName: "Ana" }, secretData: { verifyUrl: "x", resetUrl: "secret-value-2" } },
        /does not allow: resetUrl/,
      ],
      [
        { data: { fullName: 42 }, secretData: SAMPLES["auth.verify_email"].secretData },
        /not strings.*fullName/,
      ],
      [
        {
          data: { fullName: "a".repeat(MAX_VARIABLE_LENGTH + 1) },
          secretData: SAMPLES["auth.verify_email"].secretData,
        },
        /fullName/,
      ],
      [{ data: [] as unknown as Record<string, unknown>, secretData: {} }, /data must be an object/],
    ];
    for (const [variables, message] of cases) {
      expect(() => templates.render("auth.verify_email", variables, BUILT_INS)).toThrow(EmailVariablesError);
      expect(() => checkEmailVariables("auth.verify_email", variables)).toThrow(message);
      try {
        checkEmailVariables("auth.verify_email", variables);
      } catch (error) {
        expect((error as Error).message).not.toMatch(/secret-value|aaaa|42/);
      }
    }
  });

  it.each([
    ["a helper", "{{lookup this 'constructor'}}"],
    ["a block", "{{#if fullName}}x{{/if}}"],
    ["a partial", "{{> layout}}"],
    ["triple braces", "{{{fullName}}}"],
    ["a path", "{{fullName.length}}"],
    ["this", "{{this}}"],
    ["a parent path", "{{../fullName}}"],
    ["a data variable", "{{@root}}"],
  ])("refuses a template with %s: templates are logic-less", (_case, source) => {
    expect(() => templateVariables(source, "x.txt.hbs")).toThrow(EmailTemplateError);
  });

  it("refuses to load a folder with a missing file, an extra file or a variable outside an allow-list", () => {
    const missing = templatesCopy();
    rmSync(join(missing, "auth.verify_email.txt.hbs"));
    expect(loadError(missing).message).toContain("auth.verify_email.txt.hbs");

    const extra = templatesCopy();
    writeFileSync(join(extra, "auth.unknown.txt.hbs"), "Hello");
    expect(loadError(extra).message).toContain("auth.unknown.txt.hbs");

    const outside = templatesCopy();
    writeFileSync(join(outside, "tenant.welcome.txt.hbs"), "Hello {{fullName}}, {{verifyUrl}}");
    expect(loadError(outside).message).toMatch(
      /tenant\.welcome\.txt\.hbs names variables outside its allow-list: verifyUrl/,
    );
  });

  it("is copied next to the compiled code by the build, so dist/worker.js finds it", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(TEMPLATES_DIR).toBe(join(APP_DIR, "src", "notifications", "templates"));
    expect(manifest.scripts["build"]).toContain(
      "require('node:fs').cpSync('src/notifications/templates', 'dist/notifications/templates', { recursive: true })",
    );
  });
});
