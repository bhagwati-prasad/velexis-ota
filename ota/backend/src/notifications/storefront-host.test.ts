// The storefront host of a tenant's links, without PostgreSQL or SMTP (OBE-080; ADR-0018 "Custom domain lifecycle" step
// 5, PADR-0004 item 8): the two origins, when the primary custom domain is read and used, how the links an e-mail's
// payload carries move to it, and what the renderer makes of it (the shipped defaults, rendered on the primary host).
// The platform table, the worker's outbox and Mailpit are used in test/integration/tenancy/custom-domains.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { SharedConfig } from "../config";
import { TENANT_STATUSES, type TenantStatus } from "../tenancy/platform-read.types";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { OutboxRepository } from "./outbox.repository";
import { NotificationRenderer, storefrontUrl } from "./renderer";
import {
  onPrimaryOrigin,
  primaryStorefrontHost,
  rebaseStorefrontLinks,
  storefrontOrigins,
  storefrontSubdomainOrigin,
  type PrimaryHostReader,
  type StorefrontOrigins,
} from "./storefront-host";
import { TemplateService } from "./template.service";
import { TEMPLATE_REGISTRY, type SampleData } from "./templates/registry";

const TENANT_ID = "ten_01J9ZA2B4C6D8E0F2G4H6J8K0M";
const BASE_DOMAIN = "ota.example.com";
const SUBDOMAIN = "https://alpha.ota.example.com";
const CUSTOM_HOST = "travel.example.net";
const CUSTOM = `https://${CUSTOM_HOST}`;
const BOOKING_ID = "bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M";
/** A token as the auth flows make them: 43 characters of base64url. Made up, never a real one. */
const TOKEN = "tOk3n_-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";

const ON_CUSTOM: StorefrontOrigins = { subdomain: SUBDOMAIN, primary: CUSTOM };
const ON_SUBDOMAIN: StorefrontOrigins = { subdomain: SUBDOMAIN, primary: SUBDOMAIN };

function recordingLogger(): Pick<PinoLogger, "warn"> & { readonly warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

function readerAnswering(answer: () => Promise<string | null>): PrimaryHostReader & {
  readonly primaryStorefrontHost: ReturnType<typeof vi.fn>;
} {
  return { primaryStorefrontHost: vi.fn(answer) };
}

describe("the storefront origins", () => {
  it("are the sub-domain on STOREFRONT_BASE_DOMAIN, and the primary custom domain when there is one", () => {
    expect(storefrontSubdomainOrigin("alpha", BASE_DOMAIN)).toBe(SUBDOMAIN);
    expect(storefrontUrl("alpha", BASE_DOMAIN)).toBe(SUBDOMAIN);
    expect(storefrontOrigins("alpha", BASE_DOMAIN, null)).toEqual(ON_SUBDOMAIN);
    expect(storefrontOrigins("alpha", BASE_DOMAIN, CUSTOM_HOST)).toEqual(ON_CUSTOM);
    expect(storefrontOrigins("beta_travel", "stage.example.net", "book.beta.example")).toEqual({
      subdomain: "https://beta_travel.stage.example.net",
      primary: "https://book.beta.example",
    });
  });
});

describe("primaryStorefrontHost", () => {
  it("reads the verified primary custom domain of an active tenant", async () => {
    const reader = readerAnswering(() => Promise.resolve(CUSTOM_HOST));
    const logger = recordingLogger();

    expect(await primaryStorefrontHost(reader, { id: TENANT_ID, status: "active" }, logger)).toBe(
      CUSTOM_HOST,
    );
    expect(reader.primaryStorefrontHost).toHaveBeenCalledExactlyOnceWith(TENANT_ID);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("answers null while the sub-domain is primary", async () => {
    const reader = readerAnswering(() => Promise.resolve(null));

    expect(
      await primaryStorefrontHost(reader, { id: TENANT_ID, status: "active" }, recordingLogger()),
    ).toBeNull();
  });

  it("never reads the custom domain of a tenant that is not active: the edge serves only its sub-domain", async () => {
    const reader = readerAnswering(() => Promise.resolve(CUSTOM_HOST));
    const others = TENANT_STATUSES.filter(
      (status): status is Exclude<TenantStatus, "active"> => status !== "active",
    );

    for (const status of others) {
      expect(await primaryStorefrontHost(reader, { id: TENANT_ID, status }, recordingLogger())).toBeNull();
    }
    expect(reader.primaryStorefrontHost).not.toHaveBeenCalled();
  });

  it("falls back to the sub-domain when the platform cannot be read, and logs the tenant only", async () => {
    const reader = readerAnswering(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")));
    const logger = recordingLogger();

    expect(await primaryStorefrontHost(reader, { id: TENANT_ID, status: "active" }, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tenantId: TENANT_ID }),
      "storefront_host.primary_unavailable",
    );
  });
});

describe("onPrimaryOrigin", () => {
  it("moves a URL on the sub-domain to the primary origin, path, query and fragment kept", () => {
    expect(onPrimaryOrigin(`${SUBDOMAIN}/booking.html?id=${BOOKING_ID}`, ON_CUSTOM)).toBe(
      `${CUSTOM}/booking.html?id=${BOOKING_ID}`,
    );
    expect(onPrimaryOrigin(SUBDOMAIN, ON_CUSTOM)).toBe(CUSTOM);
    expect(onPrimaryOrigin(`${SUBDOMAIN}/`, ON_CUSTOM)).toBe(`${CUSTOM}/`);
    expect(onPrimaryOrigin(`${SUBDOMAIN}?lang=fr`, ON_CUSTOM)).toBe(`${CUSTOM}?lang=fr`);
    expect(onPrimaryOrigin(`${SUBDOMAIN}#trips`, ON_CUSTOM)).toBe(`${CUSTOM}#trips`);
  });

  it("leaves every other value alone: other hosts, look-alikes, ports, plain http and text", () => {
    for (const value of [
      `https://admin.ota.example.com/bookings/${BOOKING_ID}`,
      `${SUBDOMAIN}.evil.example/booking.html`,
      `${SUBDOMAIN}:8443/booking.html`,
      "http://alpha.ota.example.com/booking.html",
      "https://beta.ota.example.com/booking.html",
      "Alex Martin",
      "",
    ]) {
      expect(onPrimaryOrigin(value, ON_CUSTOM)).toBe(value);
    }
  });

  it("changes nothing while the sub-domain is primary", () => {
    const url = `${SUBDOMAIN}/booking.html?id=${BOOKING_ID}`;

    expect(onPrimaryOrigin(url, ON_SUBDOMAIN)).toBe(url);
  });
});

describe("rebaseStorefrontLinks", () => {
  const payload = {
    booking: {
      reference: "VX7K2M9Q",
      url: `${SUBDOMAIN}/booking.html?id=${BOOKING_ID}`,
      total: { amount: "412.30", currency: "EUR" },
      travellers: [{ firstName: "Alex", lastName: "Martin" }],
      segments: [{ origin: "CDG", destination: "JFK", flightNumber: "6" }],
      consoleUrl: `https://admin.ota.example.com/bookings/${BOOKING_ID}`,
    },
    refund: { amount: "", currency: "" },
    flags: [true, 2, null, `${SUBDOMAIN}/account/trips.html`],
  };

  it("moves every link on the sub-domain of a payload to the primary origin and copies the rest as it is", () => {
    const before = structuredClone(payload);

    expect(rebaseStorefrontLinks(payload, ON_CUSTOM)).toEqual({
      ...payload,
      booking: { ...payload.booking, url: `${CUSTOM}/booking.html?id=${BOOKING_ID}` },
      flags: [true, 2, null, `${CUSTOM}/account/trips.html`],
    });
    expect(payload).toEqual(before);
  });

  it("returns the payload itself while the sub-domain is primary", () => {
    expect(rebaseStorefrontLinks(payload, ON_SUBDOMAIN)).toBe(payload);
  });
});

describe("the e-mails of a tenant with a primary custom domain (renderer.ts)", () => {
  const TRX = {} as TenantTransaction;
  const tenant = { key: "alpha", name: "Alpha Travel" };
  const config = { get: () => BASE_DOMAIN } as unknown as ConfigService<SharedConfig, true>;
  const repository = {
    activeTemplates: vi.fn(() => Promise.resolve([])),
    senderSettings: vi.fn(() =>
      Promise.resolve({ brandName: "Alpha Travel", supportEmail: null, supportPhone: null }),
    ),
  } as unknown as OutboxRepository;
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
  const renderer = new NotificationRenderer(new TemplateService(repository), repository, logger, config);

  /** A booking.cancelled e-mail as the cancellation queues it: `booking.url` built on the sub-domain. */
  const cancelled = {
    id: "ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M",
    template_key: "booking.cancelled",
    locale: "en",
    payload: {
      booking: {
        ...(TEMPLATE_REGISTRY["booking.cancelled"].sampleData["booking"] as SampleData),
        url: `${storefrontUrl("alpha", BASE_DOMAIN)}/booking.html?id=${BOOKING_ID}`,
      },
      refund: { amount: "412.30", currency: "EUR" },
    },
  };
  const verify = {
    id: "ntf_01J9ZA2B4C6D8E0F2G4H6J8K0N",
    template_key: "auth.verify_email",
    locale: "en",
    payload: { customer: { firstName: "Alex" }, expiresAt: "2026-11-02T10:00:00Z" },
  };

  it("link the booking page, the brand and the account links on the primary custom domain", async () => {
    const batch = await renderer.prepare(TRX, tenant, [cancelled, verify], CUSTOM_HOST);
    const booking = await batch.render(cancelled, {});
    const account = await batch.render(verify, { token: TOKEN });

    expect(batch.brand.storefrontUrl).toBe(CUSTOM);
    // Handlebars escapes `=` in the HTML part.
    expect(booking.html).toContain(`href="${CUSTOM}/booking.html?id&#x3D;${BOOKING_ID}"`);
    expect(booking.text).toContain(`${CUSTOM}/booking.html?id=${BOOKING_ID}`);
    expect(account.text).toContain(`${CUSTOM}/account/verify.html?token=${TOKEN}`);
    for (const rendered of [booking, account]) {
      expect(`${rendered.html ?? ""}${rendered.text}`).not.toContain("alpha.ota.example.com");
    }
  });

  it("link the sub-domain while it is primary, as before", async () => {
    const batch = await renderer.prepare(TRX, tenant, [cancelled]);
    const booking = await batch.render(cancelled, {});

    expect(batch.brand.storefrontUrl).toBe(SUBDOMAIN);
    expect(booking.text).toContain(`${SUBDOMAIN}/booking.html?id=${BOOKING_ID}`);
    expect(booking.text).not.toContain(CUSTOM_HOST);
  });
});
