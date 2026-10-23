// The shipped default templates (OBE-055; OADR-0013 items 3–5 and 8, OADR-0015 point 5, ota/docs/flows/
// ticketing-and-documents.md §3 step 7): every key's three files compile in strict mode against the key's allow-list
// (registry.ts) and render with its sample data, a variable outside the allow-list fails, and the booking and staff
// e-mails say what OADR-0013 asks: links to the booking page on the storefront host, invoices from the OTA, the
// documents attached or the booking page instead, the console link for staff. The sending paths (attachments, staff
// recipients) run against PostgreSQL, Redis and Mailpit in test/integration/notifications/booking-emails.int.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import { ATTACHMENT_RULES } from "../attachments";
import {
  compileTemplate,
  TemplateInvalidError,
  TemplateRenderError,
  type CompiledTemplate,
} from "../template.service";
import {
  attachesDocuments,
  callerVariables,
  DEFAULT_TEMPLATE_LOCALE,
  DOCUMENTS_ATTACHED_VARIABLE,
  loadTemplateDefault,
  TEMPLATE_KEYS,
  TEMPLATE_PARTS,
  TEMPLATE_REGISTRY,
  type SampleData,
  type TemplateKey,
  type TemplatePart,
  type TemplateSource,
} from "./registry";

/** The keys of OBE-055: the booking e-mails to travellers and the staff alerts. */
const BOOKING_KEYS = TEMPLATE_KEYS.filter((key) => key.startsWith("booking."));
const STAFF_KEYS = TEMPLATE_KEYS.filter((key) => key.startsWith("staff."));

const sources = new Map<TemplateKey, TemplateSource>();
const compiled = new Map<TemplateKey, CompiledTemplate>();

/** The sample data of a key, as the console preview renders it. */
const sample = (key: TemplateKey): SampleData => TEMPLATE_REGISTRY[key].sampleData;

/** A copy of `data` with `path` (dotted) set to `value`. */
function withValue(data: SampleData, path: string, value: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const segments = path.split(".");
  let current = copy;
  for (const segment of segments.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] ?? path] = value;
  return copy;
}

function compiledOf(key: TemplateKey): CompiledTemplate {
  const template = compiled.get(key);
  if (template === undefined) {
    throw new Error(`no compiled default for ${key}`);
  }
  return template;
}

function sourceOf(key: TemplateKey): TemplateSource {
  const source = sources.get(key);
  if (source === undefined) {
    throw new Error(`no default for ${key}`);
  }
  return source;
}

/** An attribute value as a browser reads it: Handlebars escapes `&`, `=`, quotes and angle brackets as entities. */
function unescapeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The `href` values of an HTML part, unescaped. */
const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => unescapeAttribute(match[1] ?? ""));

// Reading the 33 files and checking and compiling them takes a few milliseconds; once, here, with the default budget.
beforeAll(async () => {
  for (const key of TEMPLATE_KEYS) {
    const source = await loadTemplateDefault(key);
    if (source === undefined) {
      continue;
    }
    sources.set(key, source);
    compiled.set(
      key,
      compileTemplate({
        key,
        origin: "default",
        locale: DEFAULT_TEMPLATE_LOCALE,
        templateId: null,
        version: 0,
        sources: { subject: source.subject, html: source.html, text: source.text },
      }),
    );
  }
});

describe("the shipped defaults", () => {
  it("[OBE-055 AC1] exist for every MVP key and compile in strict mode against the key's allow-list", () => {
    expect([...sources.keys()]).toEqual([...TEMPLATE_KEYS]);
    expect([...compiled.keys()]).toEqual([...TEMPLATE_KEYS]);
  });

  it.each(TEMPLATE_KEYS)("[OBE-055 AC1] %s renders with its sample data", (key) => {
    const rendered = compiledOf(key).render(sample(key));

    expect(rendered.subject).not.toBe("");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html).toMatch(/^<!DOCTYPE html>/);
    for (const part of [rendered.subject, rendered.html ?? "", rendered.text]) {
      expect(part).not.toMatch(/\{\{|\}\}/);
    }
    // The brand heads the HTML part and signs or names the OTA in the text part.
    expect(rendered.html).toContain("Demo Travel");
    expect(rendered.text).toContain("Demo Travel");
    // The text part is plain text.
    expect(rendered.text).not.toMatch(/<[a-z!/][^>]*>/i);
  });

  it.each(TEMPLATE_KEYS)(
    "[OBE-055 AC1] %s fails in strict mode when a variable it uses is missing",
    (key) => {
      const data: Record<string, unknown> = { ...sample(key) };
      delete data["brand"];

      expect(() => compiledOf(key).render(data)).toThrow(TemplateRenderError);
    },
  );

  it.each(
    TEMPLATE_KEYS.flatMap((key) => TEMPLATE_PARTS.map((part): [TemplateKey, TemplatePart] => [key, part])),
  )("[OBE-055 AC1] %s with a variable outside its allow-list in its %s part fails the check", (key, part) => {
    const source = sourceOf(key);
    const outside = "{{booking.passportNumber}}";
    const sources = {
      subject: part === "subject" ? `${source.subject} ${outside}` : source.subject,
      html: part === "html" ? `${source.html}${outside}` : source.html,
      text: part === "txt" ? `${source.text}${outside}` : source.text,
    };

    let error: unknown;
    try {
      compileTemplate({
        key,
        origin: "default",
        locale: DEFAULT_TEMPLATE_LOCALE,
        templateId: null,
        version: 0,
        sources,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TemplateInvalidError);
    expect((error as TemplateInvalidError).problems).toEqual([
      expect.objectContaining({
        part,
        message: expect.stringMatching(/^"booking\.passportNumber" is not a variable of /) as unknown,
      }),
    ]);
  });
});

describe("the booking e-mails", () => {
  it.each(BOOKING_KEYS)(
    "[OBE-055 step 1] %s links to /booking.html?id=bkg_… on the storefront host, and nowhere else",
    (key) => {
      const data = sample(key);
      const url = (data["booking"] as SampleData)["url"] as string;
      const storefront = (data["brand"] as SampleData)["storefrontUrl"] as string;
      expect(url).toMatch(/^https:\/\/demo\.ota\.example\.com\/booking\.html\?id=bkg_[0-9A-Z]{26}$/);

      const rendered = compiledOf(key).render(data);

      expect(hrefsOf(rendered.html ?? "")).toContain(url);
      expect(rendered.text).toContain(url);
      for (const href of hrefsOf(rendered.html ?? "")) {
        expect(
          href.startsWith(`${storefront}/`) || href === storefront || href.startsWith("mailto:"),
          href,
        ).toBe(true);
      }
    },
  );

  it.each(BOOKING_KEYS)(
    "[OBE-055 step 1] %s names the booking, its flights and the support address",
    (key) => {
      const rendered = compiledOf(key).render(sample(key));

      for (const part of [rendered.html ?? "", rendered.text]) {
        expect(part).toContain("VX7K2M9Q");
        expect(part).toContain("CDG to JFK");
        expect(part).toContain("support@demo.example.com");
      }
      expect(rendered.subject).toContain("VX7K2M9Q");
    },
  );

  it("[OBE-055 step 1] the confirmation says that invoices come from the OTA", () => {
    const rendered = compiledOf("booking.confirmed").render(sample("booking.confirmed"));

    for (const part of [rendered.html ?? "", rendered.text.replace(/\s+/g, " ")]) {
      expect(part).toContain("This e-mail is not an invoice.");
      expect(part).toContain("Invoices for this booking are issued by Demo Travel");
    }
  });

  it.each([
    [
      "booking.confirmed",
      "Your itinerary is attached",
      "Your itinerary will be ready to download on your booking page",
    ],
    [
      "booking.ticketed",
      "The e-ticket receipts are attached",
      "The e-ticket receipts will be ready to download on your booking page",
    ],
  ] as const)(
    "[OBE-055 step 3] %s says whether its documents are attached or on the booking page",
    (key, attached, link) => {
      const withDocuments = compiledOf(key).render(withValue(sample(key), DOCUMENTS_ATTACHED_VARIABLE, true));
      const withLink = compiledOf(key).render(withValue(sample(key), DOCUMENTS_ATTACHED_VARIABLE, false));

      for (const part of [withDocuments.html ?? "", withDocuments.text]) {
        expect(part).toContain(attached);
        expect(part).not.toContain(link);
      }
      for (const part of [withLink.html ?? "", withLink.text]) {
        expect(part).toContain(link);
        expect(part).not.toContain(attached);
      }
    },
  );

  it("[OBE-055 step 1] the e-ticket e-mail lists each ticket with its traveller", () => {
    const rendered = compiledOf("booking.ticketed").render(sample("booking.ticketed"));

    expect(rendered.text).toContain("- Alex Martin: 0571234567890");
    expect(rendered.html).toContain("0571234567890");
  });

  it("[OBE-055 step 1] the cancellation names a refund only when there is one", () => {
    const refunded = compiledOf("booking.cancelled").render(sample("booking.cancelled"));
    const none = compiledOf("booking.cancelled").render(
      withValue(sample("booking.cancelled"), "refund", { amount: "", currency: "" }),
    );

    expect(refunded.text).toContain("A refund of 412.30 EUR");
    expect(none.text).not.toContain("A refund of");
    expect(none.text).toContain("If an amount is due back to you, Demo Travel will tell you");
  });

  it("[OBE-055 step 1] escapes the traveller's data in the HTML part and keeps it as written in the text part", () => {
    const data = withValue(sample("booking.confirmed"), "booking.travellers", [
      { firstName: "<script>alert(1)</script>", lastName: "O'Brien & Co" },
    ]);

    const rendered = compiledOf("booking.confirmed").render(data);

    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).toContain("O&#x27;Brien &amp; Co");
    expect(rendered.text).toContain("- <script>alert(1)</script> O'Brien & Co");
  });
});

describe("the staff alerts", () => {
  it.each(STAFF_KEYS)("[OBE-055 step 1] %s links to the booking in the OTA admin", (key) => {
    const data = sample(key);
    const consoleUrl = (data["booking"] as SampleData)["consoleUrl"] as string;

    const rendered = compiledOf(key).render(data);

    expect(hrefsOf(rendered.html ?? "")).toContain(consoleUrl);
    expect(rendered.text).toContain(consoleUrl);
    expect(rendered.text).toContain("VX7K2M9Q");
  });

  it("[OBE-055 step 1] staff.manual_review names a payment alert without a booking", () => {
    const data = withValue(sample("staff.manual_review"), "booking", {
      reference: "",
      recordLocator: "",
      consoleUrl: "https://admin.ota.example.com/payments/pay_01J9ZA2B4C6D8E0F2G4H6J8K0M",
    });

    const rendered = compiledOf("staff.manual_review").render(data);

    expect(rendered.subject).toBe("[Action needed] A payment needs a review");
    expect(rendered.text).toContain("The ticketing policy of the OTA is manual review.");
    expect(rendered.text).not.toContain("Booking reference");
  });

  it("[OBE-055 step 1] staff.ticketing_failed gives the attempts and the last error", () => {
    const rendered = compiledOf("staff.ticketing_failed").render(sample("staff.ticketing_failed"));

    expect(rendered.subject).toBe("[Action needed] Ticketing failed for booking VX7K2M9Q");
    expect(rendered.text).toContain("Attempts made: 3");
    expect(rendered.text).toContain("AMADEUS_ERROR - The airline refused the ticketing request.");
  });
});

describe("the variables the sender fills", () => {
  it("[OBE-055 step 3] documents.attached is a variable of exactly the keys that attach documents, never a caller's", () => {
    const attaching = TEMPLATE_KEYS.filter((key) => attachesDocuments(key));

    expect(attaching).toEqual(["booking.confirmed", "booking.ticketed"]);
    expect(Object.keys(ATTACHMENT_RULES).sort()).toEqual([...attaching].sort());
    for (const key of TEMPLATE_KEYS) {
      expect(callerVariables(key).map((entry) => entry.name)).not.toContain(DOCUMENTS_ATTACHED_VARIABLE);
    }
  });
});
