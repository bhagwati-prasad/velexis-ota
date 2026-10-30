// The payout account (PBE-058; platform/docs/flows/stripe-payments-account.md §B, PADR-0003 item 10, api-inventory-
// resources.md §5 and api-inventory-admin.md §6, scope PF-64) through the HTTP pipeline (createTestApp) on this file's
// database clone and this worker's Redis database:
//
// - the portal: owners set the account with a TOTP step-up while `FEATURE_SETTLEMENTS` is on; a wrong IBAN checksum
//   answers `400 VALIDATION_FAILED` without the value; a valid IBAN is stored envelope-encrypted (bound to the row),
//   answered masked (`last4`), audited without numbers and announced to ops; owners and finance members read it masked;
//   the stored account typed again changes nothing, while one changed field is a change (FIX-W35-PLATFORM);
// - the platform admin: the masked view, the reveal (a reason and a step-up, `no-store`, one audit row with the reason
//   and no number) and the review (`If-Match`, the owners e-mailed `payouts.reviewed`).
//
// The milestone switches are a stand-in this file turns on (as plans.int.test.ts does), so one application shows the
// switch off too. Every answer is checked against the platform document. The application logs at `trace`, so "no
// bank number in a log line", checked after every test, covers every level; the e-mails are rendered with the
// worker's templates to check what a person would read. The bank numbers are documentation examples (an ISO 13616 IBAN, the OpenAPI document's
// examples), test values only.
import { expectResponseToMatch } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FeatureSwitches,
  FEATURES,
  featuresFor,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { EmailTemplates, type EmailTemplateKey } from "../../../src/notifications/templates";
import { bankDetailsPlace } from "../../../src/settlements/payout-accounts.service";
import { insertAccount, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API (database clone, Nest module graph, Ajv compilation of the document) takes seconds on CI. */
const SETUP_TIMEOUT_MS = 60_000;
const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.58";
const ADMIN_IP = "198.51.100.58";

/** An IBAN as an owner types it (the ISO 13616 documentation example), its stored form and its last 4 characters. */
const IBAN_TYPED = "gb82 west 1234 5698 7654 32";
const IBAN = "GB82WEST12345698765432";
/** The same IBAN with its last digit changed: the mod-97 check fails. */
const IBAN_WRONG_CHECKSUM = "GB82 WEST 1234 5698 7654 33";
/** The OpenAPI document's examples of a Norwegian IBAN with its BIC and of a US account (Stripe's test numbers). */
const NO_IBAN = "NO9386011117947";
const ACCOUNT_NUMBER = "000123456789";
const ROUTING_NUMBER = "110000000";
/** Another routing number for the same account number (a test value only). */
const ROUTING_NUMBER_CHANGED = "110000001";
/**
 * Another valid IBAN and another account number with the same last 4 as IBAN and ACCOUNT_NUMBER (test values only):
 * the masked account stays the same, so only the decrypted identifiers tell the change.
 */
const IBAN_SAME_LAST4_TYPED = "GB32 WEST 1234 5699 7654 32";
const IBAN_SAME_LAST4 = "GB32WEST12345699765432";
const ACCOUNT_NUMBER_SAME_LAST4 = "999123456789";
/**
 * Every bank number and BIC of this file, as typed and as stored (the BICs are write-only like the numbers): none may
 * reach a log line, an audit row, an error answer or an e-mail.
 */
const NUMBERS = [
  IBAN,
  "WEST12345698765432",
  "1234 5698 7654",
  "GB82WEST12345698765433",
  "1234 5698 7654 33",
  NO_IBAN,
  "86011117947",
  "8601 1117 947",
  ACCOUNT_NUMBER,
  ROUTING_NUMBER,
  ROUTING_NUMBER_CHANGED,
  IBAN_SAME_LAST4,
  "WEST12345699765432",
  "1234 5699 7654",
  ACCOUNT_NUMBER_SAME_LAST4,
  "WESTGB2L",
  "westgb2l",
  "DNBANOKK",
];

/** The milestone switches of this application: `settlements` on unless a test turns it off. */
class TestSwitches {
  readonly on = new Set<Feature>();

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let envelope: EnvelopeService;
let templates: EmailTemplates;
let admin: string;
const switches = new TestSwitches();

beforeAll(async () => {
  // Every line at every level is captured, so "no log line holds a bank number" covers the debug and trace lines too.
  t = await createTestApp({
    env: { LOG_LEVEL: "trace" },
    overrides: [{ provide: FeatureSwitches, useValue: switches }],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  envelope = t.app.get(EnvelopeService);
  // The worker's templates, to render the queued e-mails as the worker would.
  templates = EmailTemplates.load();
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  switches.on.add("settlements");
});

afterEach(() => {
  switches.on.clear();
});

// After every test, not only the ones that look: no line the application logged so far, at any level, holds a bank
// number or a BIC (the reveals and reviews of the later tests included).
afterEach(() => {
  expectNoBankNumber((t?.logs.lines ?? []).map((line) => JSON.stringify(line)).join("\n"));
});

/** An OTA with a member of every role (the owner with MFA), an owner without MFA, and a stranger. */
interface Fixture {
  readonly tenant: PlatformRow<"tenants">;
  readonly people: ReadonlyMap<TenantRole | "ownerWithoutMfa" | "stranger", PlatformRow<"accounts">>;
}

async function fixture(): Promise<Fixture> {
  const ota = await insertOta(pool);
  const people = new Map<TenantRole | "ownerWithoutMfa" | "stranger", PlatformRow<"accounts">>();
  for (const role of TENANT_ROLES) {
    const account = await insertAccount(pool, role === "owner" ? { mfa_enabled: true } : {});
    await insertMember(pool, ota.tenant, account, role);
    people.set(role, account);
  }
  const ownerWithoutMfa = await insertAccount(pool);
  await insertMember(pool, ota.tenant, ownerWithoutMfa, "owner");
  people.set("ownerWithoutMfa", ownerWithoutMfa);
  people.set("stranger", await insertAccount(pool));
  return { tenant: ota.tenant, people };
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** The claims of a TOTP verification now. */
const STEP_UP = (): Partial<AccessTokenInput> => ({ amr: ["pwd", "otp"], mfa_at: nowSeconds() });

function person(f: Fixture, who: TenantRole | "ownerWithoutMfa" | "stranger"): PlatformRow<"accounts"> {
  const account = f.people.get(who);
  if (account === undefined) {
    throw new Error(`no ${who} in the fixture`);
  }
  return account;
}

/** The headers of a portal call by `who`, with a step-up now unless `stepUp` is false. */
async function portal(
  f: Fixture,
  who: TenantRole | "ownerWithoutMfa" | "stranger",
  stepUp = true,
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: person(f, who).id,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...(stepUp ? STEP_UP() : {}),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The headers of an admin call: a `platform_admin` token, with a TOTP step-up now unless `stepUp` is false. */
async function adminHeaders(stepUp = true): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
    ...(stepUp ? { mfa_at: nowSeconds() } : {}),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

const ibanBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountHolderName: "Agency Travel AS",
  countryCode: "GB",
  currency: "GBP",
  scheme: "iban",
  iban: IBAN_TYPED,
  bic: "westgb2l",
  ...overrides,
});

const localBody = (): Record<string, unknown> => ({
  accountHolderName: "Agency Travel Inc.",
  countryCode: "US",
  currency: "USD",
  scheme: "local",
  accountNumber: ACCOUNT_NUMBER,
  routingNumber: ROUTING_NUMBER,
});

const path = (f: Fixture): string => `/v1/tenants/${f.tenant.id}/payout-account`;
const adminPath = (tenantId: string, action = ""): string =>
  `/v1/admin/tenants/${tenantId}/payout-account${action === "" ? "" : `/${action}`}`;

async function setAccount(
  f: Fixture,
  body: Record<string, unknown>,
  who: TenantRole | "ownerWithoutMfa" | "stranger" = "owner",
  stepUp = true,
): Promise<Response> {
  return t.http
    .put(path(f))
    .set(await portal(f, who, stepUp))
    .send(body);
}

async function reveal(tenantId: string, body: unknown, stepUp = true): Promise<Response> {
  return t.http
    .post(adminPath(tenantId, "reveal"))
    .set(await adminHeaders(stepUp))
    .send(body as object);
}

async function review(tenantId: string, ifMatch: string, body: unknown): Promise<Response> {
  return t.http
    .post(adminPath(tenantId, "review"))
    .set(await adminHeaders())
    .set("If-Match", ifMatch)
    .send(body as object);
}

function errorOf(res: Response): {
  code: string;
  details?: Record<string, unknown>;
  fieldErrors?: Array<{ path: string; code: string; message?: string }>;
} {
  return (
    res.body as {
      error: {
        code: string;
        details?: Record<string, unknown>;
        fieldErrors?: Array<{ path: string; code: string; message?: string }>;
      };
    }
  ).error;
}

/** A typed IBAN without its spaces, upper case: the form a careless message could echo. */
const normalisedOf = (typed: string): string => typed.replace(/\s+/g, "").toUpperCase();

const outcomeOf = (res: Response): string =>
  res.status < 400 ? String(res.status) : `${res.status} ${errorOf(res).code}`;

async function storedRow(tenantId: string): Promise<PlatformRow<"tenant_payout_accounts"> | undefined> {
  const { rows } = await pool.query("SELECT * FROM platform.tenant_payout_accounts WHERE tenant_id = $1", [
    tenantId,
  ]);
  return rows[0] as PlatformRow<"tenant_payout_accounts"> | undefined;
}

async function auditOf(tenantId: string, action: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id",
    [tenantId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

interface OutboxRow {
  readonly template: EmailTemplateKey;
  readonly to_email: string;
  readonly account_id: string | null;
  readonly data: Record<string, string>;
  readonly secret_payload_ciphertext: Buffer | null;
}

async function emailsOf(tenantId: string, template: string): Promise<OutboxRow[]> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.email_outbox WHERE tenant_id = $1 AND template = $2 ORDER BY created_at, id",
    [tenantId, template],
  );
  return rows as OutboxRow[];
}

/** The subject, HTML and text of a queued e-mail, rendered by the worker's templates. */
function rendered(row: OutboxRow): string {
  const email = templates.render(
    row.template,
    { data: row.data, secretData: {} },
    { portalUrl: t.config.PUBLIC_PORTAL_URL, adminUrl: t.config.PUBLIC_PLATFORM_ADMIN_URL },
  );
  return [email.subject, email.html, email.text].join("\n");
}

/** Asserts that `text` holds none of this file's bank numbers. */
function expectNoBankNumber(text: string): void {
  for (const number of NUMBERS) {
    expect(text).not.toContain(number);
  }
}

/** Asserts that the application logged the requests of `route` (method and status) and no bank number at all. */
function expectLogsWithoutBankNumbers(method: string, route: string, statuses: readonly number[]): void {
  const requests = t.logs.lines.filter((line) => line["method"] === method && line["route"] === route);
  expect(requests.map((line) => line["status"])).toEqual(expect.arrayContaining([...statuses]));
  expectNoBankNumber(t.logs.lines.map((line) => JSON.stringify(line)).join("\n"));
}

describe("setPayoutAccount and getPayoutAccount (portal)", () => {
  it("[PBE-058 AC1] answers 400 VALIDATION_FAILED on /iban for a wrong checksum, without the value, and stores nothing", async () => {
    const f = await fixture();

    const res = await setAccount(f, ibanBody({ iban: IBAN_WRONG_CHECKSUM }));

    expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
    expectResponseToMatch("setPayoutAccount", res, { document: "platform" });
    expect(errorOf(res).fieldErrors).toEqual([
      { path: "/iban", code: "iban_checksum", message: "Check the IBAN; its check digits do not match." },
    ]);
    expectNoBankNumber(JSON.stringify(res.body));
    expect(await storedRow(f.tenant.id)).toBeUndefined();
    expect(await auditOf(f.tenant.id, "payout_account.updated")).toEqual([]);
    expect(await emailsOf(f.tenant.id, "ops.alert")).toEqual([]);
  });

  it("[PBE-058 AC1] answers the service's own rules as 400 field errors without the value, and stores nothing", async () => {
    const f = await fixture();
    // Each passes the document's request schema and breaks a rule of iban.ts or of the service.
    const shortIban = "GB82 1234         ";
    const shortAccountNumber = "1-2 3";

    const refused = [
      await setAccount(f, ibanBody({ iban: shortIban })),
      await setAccount(f, { ...localBody(), accountNumber: shortAccountNumber }),
      await setAccount(f, ibanBody({ accountHolderName: "   " })),
    ];

    expect(refused.map(outcomeOf)).toEqual(Array(3).fill("400 VALIDATION_FAILED"));
    expect(refused.map((res) => errorOf(res).fieldErrors?.map(({ path: at, code }) => [at, code]))).toEqual([
      [["/iban", "iban_format"]],
      [["/accountNumber", "account_number_format"]],
      [["/accountHolderName", "blank"]],
    ]);
    for (const res of refused) {
      expectResponseToMatch("setPayoutAccount", res, { document: "platform" });
      const body = JSON.stringify(res.body);
      for (const value of [shortIban.trim(), normalisedOf(shortIban), shortAccountNumber]) {
        expect(body).not.toContain(value);
      }
      expectNoBankNumber(body);
    }
    expect(await storedRow(f.tenant.id)).toBeUndefined();
    expect(await auditOf(f.tenant.id, "payout_account.updated")).toEqual([]);
    expect(await emailsOf(f.tenant.id, "ops.alert")).toEqual([]);
  });

  it("[PBE-058 AC1] stores a valid IBAN encrypted and bound to the row, answers it as last4, audits it without numbers and alerts ops", async () => {
    const f = await fixture();
    const owner = person(f, "owner");

    const res = await setAccount(f, ibanBody());

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("setPayoutAccount", res, { document: "platform" });
    expect(res.body).toEqual({
      accountHolderName: "Agency Travel AS",
      countryCode: "GB",
      currency: "GBP",
      scheme: "iban",
      last4: "5432",
      status: "pending_review",
      reviewNote: null,
      updatedAt: t.clock.now().toISOString(),
      version: 1,
    });
    expect(res.headers["etag"]).toBe('"1"');
    expectNoBankNumber(JSON.stringify(res.body));

    // Stored: the identifiers only as an envelope of the JSON, bound to this row; `last4` in clear.
    const row = await storedRow(f.tenant.id);
    expect(row).toMatchObject({
      scheme: "iban",
      last4: "5432",
      status: "pending_review",
      encryption_key_id: envelope.currentKekId(),
      updated_by_account_id: owner.id,
      version: 1,
    });
    const ciphertext = row?.bank_details_ciphertext ?? Buffer.alloc(0);
    expectNoBankNumber(ciphertext.toString("latin1"));
    await expect(envelope.decryptJson(ciphertext, bankDetailsPlace(f.tenant.id))).resolves.toEqual({
      iban: IBAN,
      bic: "WESTGB2L",
    });
    // The associated data binds the value to the tenant's row: another row's place cannot decrypt it.
    const other = await fixture();
    await expect(envelope.decryptJson(ciphertext, bankDetailsPlace(other.tenant.id))).rejects.toThrow();

    // One audit row by the owner: the masked fields, never a number.
    const audit = await auditOf(f.tenant.id, "payout_account.updated");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "account",
      actor_account_id: owner.id,
      target_type: "payout_account",
      target_id: f.tenant.id,
      details: {
        version: 1,
        after: {
          accountHolderName: "Agency Travel AS",
          countryCode: "GB",
          currency: "GBP",
          scheme: "iban",
          last4: "5432",
          status: "pending_review",
        },
      },
    });
    expectNoBankNumber(JSON.stringify(audit));

    // One ops alert, without a number.
    const alerts = await emailsOf(f.tenant.id, "ops.alert");
    expect(alerts.map((email) => [email.to_email, email.secret_payload_ciphertext])).toEqual([
      [t.config.OPS_ALERT_EMAIL, null],
    ]);
    const alert = rendered(alerts[0] as OutboxRow);
    expect(alert).toContain(`Payout account to review: ${f.tenant.name} (${f.tenant.key})`);
    expectNoBankNumber(alert);

    // Owners and finance members read it masked, with its version in ETag.
    for (const who of ["owner", "finance"] as const) {
      const read = await t.http.get(path(f)).set(await portal(f, who, false));
      expect(outcomeOf(read), who).toBe("200");
      expectResponseToMatch("getPayoutAccount", read, { document: "platform" });
      expect(read.body).toEqual(res.body);
      expect(read.headers["etag"]).toBe('"1"');
    }
    expectLogsWithoutBankNumbers("PUT", "/v1/tenants/:tenantId/payout-account", [200, 400]);
  });

  it("[PBE-058 AC1] stores a local account as typed and shows the last 4 digits of the account number", async () => {
    const f = await fixture();

    const res = await setAccount(f, localBody());

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("setPayoutAccount", res, { document: "platform" });
    expect(res.body).toMatchObject({ scheme: "local", last4: "6789", status: "pending_review", version: 1 });
    const row = await storedRow(f.tenant.id);
    await expect(
      envelope.decryptJson(row?.bank_details_ciphertext ?? Buffer.alloc(0), bankDetailsPlace(f.tenant.id)),
    ).resolves.toEqual({ accountNumber: ACCOUNT_NUMBER, routingNumber: ROUTING_NUMBER });
  });

  it("[PBE-058 AC1] a change of a verified account returns it to pending_review with the review cleared", async () => {
    const f = await fixture();
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");
    expect(
      outcomeOf(
        await review(f.tenant.id, '"1"', { decision: "rejected", note: "The holder name is wrong." }),
      ),
    ).toBe("200");
    expect(outcomeOf(await review(f.tenant.id, '"2"', { decision: "verified" }))).toBe("200");

    const res = await setAccount(
      f,
      ibanBody({ countryCode: "NO", currency: "NOK", iban: "NO93 8601 1117 947", bic: "DNBANOKK" }),
    );

    expect(outcomeOf(res)).toBe("200");
    expect(res.body).toMatchObject({ last4: "7947", status: "pending_review", reviewNote: null, version: 4 });
    expect(await storedRow(f.tenant.id)).toMatchObject({
      status: "pending_review",
      review_note: null,
      reviewed_by_account_id: null,
      reviewed_at: null,
      version: 4,
    });
    const audit = await auditOf(f.tenant.id, "payout_account.updated");
    expect(audit.map((row) => row["details"])).toEqual([
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({
        version: 4,
        before: expect.objectContaining({ last4: "5432", status: "verified" }) as unknown,
        after: expect.objectContaining({ last4: "7947", status: "pending_review" }) as unknown,
      }),
    ]);
    expect((await emailsOf(f.tenant.id, "ops.alert")).length).toBe(2);
  });

  it("[FIX-W35-PLATFORM AC3] the stored account typed again changes nothing: the same answer, verified stays verified, no audit row, no ops alert", async () => {
    const f = await fixture();
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");
    expect(outcomeOf(await review(f.tenant.id, '"1"', { decision: "verified" }))).toBe("200");
    const current = await t.http.get(path(f)).set(await portal(f, "owner", false));
    expect(current.body).toMatchObject({ status: "verified", version: 2 });
    const storedBefore = await storedRow(f.tenant.id);
    t.clock.advance(60_000);

    // The same account as the save normalises it: the holder trimmed, the IBAN without spaces and upper-cased, the
    // BIC upper-cased.
    const res = await setAccount(
      f,
      ibanBody({ accountHolderName: "  Agency Travel AS ", iban: IBAN, bic: "WESTGB2L" }),
    );

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("setPayoutAccount", res, { document: "platform" });
    expect(res.body).toEqual(current.body);
    expect(res.headers["etag"]).toBe('"2"');
    // Nothing was written: the same ciphertext, version, review and writer.
    expect(await storedRow(f.tenant.id)).toEqual(storedBefore);
    expect(storedBefore).toMatchObject({ status: "verified", reviewed_by_account_id: admin, version: 2 });
    expect((await auditOf(f.tenant.id, "payout_account.updated")).map((row) => row["details"])).toEqual([
      expect.objectContaining({ version: 1 }),
    ]);
    expect(await emailsOf(f.tenant.id, "ops.alert")).toHaveLength(1);
    expect(await emailsOf(f.tenant.id, "payouts.reviewed")).toHaveLength(2);

    // A local account typed again keeps its pending review, version and time as well.
    const g = await fixture();
    const first = await setAccount(g, localBody());
    t.clock.advance(60_000);
    const again = await setAccount(g, localBody());
    expect(outcomeOf(again)).toBe("200");
    expect(again.body).toEqual(first.body);
    expect(again.body).toMatchObject({ status: "pending_review", version: 1 });
    expect(again.headers["etag"]).toBe('"1"');
    expect(await auditOf(g.tenant.id, "payout_account.updated")).toHaveLength(1);
    expect(await emailsOf(g.tenant.id, "ops.alert")).toHaveLength(1);
    expectLogsWithoutBankNumbers("PUT", "/v1/tenants/:tenantId/payout-account", [200]);
  });

  it("[FIX-W35-PLATFORM AC3] one changed field after normalisation is a change: a new version back in pending_review, an audit row and an ops alert", async () => {
    const f = await fixture();
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");
    const holder = "Agency Travel AS Ltd";
    const withoutBic = Object.fromEntries(
      Object.entries(ibanBody({ accountHolderName: holder })).filter(([key]) => key !== "bic"),
    );
    const iban = { accountHolderName: holder, bic: "DNBANOKK", currency: "EUR", countryCode: "IE" };
    const local = { ...localBody(), accountHolderName: holder, routingNumber: ROUTING_NUMBER_CHANGED };
    // Each differs from the account stored before it in one thing only (the scheme comes with its own identifiers,
    // country and currency). The BIC, the IBAN and the account number with the same last 4 and the routing number
    // change nothing of the masked account: only the identifiers, decrypted and compared, tell them apart.
    const changes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["holder", ibanBody({ accountHolderName: holder })],
      ["no BIC", withoutBic],
      ["BIC", ibanBody({ accountHolderName: holder, bic: "DNBANOKK" })],
      ["currency", ibanBody({ accountHolderName: holder, bic: "DNBANOKK", currency: "EUR" })],
      ["country", ibanBody(iban)],
      ["IBAN with the same last 4", ibanBody({ ...iban, iban: IBAN_SAME_LAST4_TYPED })],
      ["scheme", { ...localBody(), accountHolderName: holder }],
      ["routing number", local],
      ["account number with the same last 4", { ...local, accountNumber: ACCOUNT_NUMBER_SAME_LAST4 }],
    ];
    let version = 1;
    for (const [what, body] of changes) {
      expect(outcomeOf(await review(f.tenant.id, `"${version}"`, { decision: "verified" })), what).toBe(
        "200",
      );
      const res = await setAccount(f, body);
      version += 2;
      const last4 = body["scheme"] === "local" ? "6789" : "5432";
      expect(outcomeOf(res), what).toBe("200");
      expect(res.body, what).toMatchObject({ status: "pending_review", reviewNote: null, version, last4 });
      expect(res.headers["etag"], what).toBe(`"${version}"`);
    }
    const audit = await auditOf(f.tenant.id, "payout_account.updated");
    expect(audit.map((row) => (row["details"] as { version: number }).version)).toEqual(
      Array.from({ length: changes.length + 1 }, (_, index) => 1 + 2 * index),
    );
    expect(
      audit.slice(1).map((row) => (row["details"] as { before: { status: string } }).before.status),
    ).toEqual(Array(changes.length).fill("verified"));
    expect(await emailsOf(f.tenant.id, "ops.alert")).toHaveLength(changes.length + 1);
    const decrypted = async (tenantId: string): Promise<unknown> =>
      envelope.decryptJson(
        (await storedRow(tenantId))?.bank_details_ciphertext ?? Buffer.alloc(0),
        bankDetailsPlace(tenantId),
      );
    await expect(decrypted(f.tenant.id)).resolves.toEqual({
      accountNumber: ACCOUNT_NUMBER_SAME_LAST4,
      routingNumber: ROUTING_NUMBER_CHANGED,
    });

    // A stored copy that cannot be decrypted (here another OTA's, bound to that OTA's row) is replaced, not matched,
    // even when the account typed is the one that copy holds and the masked columns are the stored ones.
    const other = await fixture();
    expect(outcomeOf(await setAccount(other, localBody()))).toBe("200");
    await pool.query(
      "UPDATE platform.tenant_payout_accounts SET bank_details_ciphertext = $1 WHERE tenant_id = $2",
      [(await storedRow(other.tenant.id))?.bank_details_ciphertext, f.tenant.id],
    );
    const replaced = await setAccount(f, { ...localBody(), accountHolderName: holder });
    expect(outcomeOf(replaced)).toBe("200");
    expect(replaced.body).toMatchObject({ status: "pending_review", version: version + 1, last4: "6789" });
    await expect(decrypted(f.tenant.id)).resolves.toEqual({
      accountNumber: ACCOUNT_NUMBER,
      routingNumber: ROUTING_NUMBER,
    });
    expect(await auditOf(f.tenant.id, "payout_account.updated")).toHaveLength(changes.length + 2);
    expect(await emailsOf(f.tenant.id, "ops.alert")).toHaveLength(changes.length + 2);
  });

  it("needs a step-up, MFA, the settlements switch and the owner role, and writes nothing otherwise", async () => {
    const f = await fixture();

    const withoutStepUp = await setAccount(f, ibanBody(), "owner", false);
    const withoutMfa = await setAccount(f, ibanBody(), "ownerWithoutMfa");
    const notOwner = await Promise.all(
      (["admin", "agent", "finance", "viewer"] as const).map(async (who) => setAccount(f, ibanBody(), who)),
    );
    const stranger = await setAccount(f, ibanBody(), "stranger");
    switches.on.delete("settlements");
    const switchedOff = await setAccount(f, ibanBody());

    expect(outcomeOf(withoutStepUp)).toBe("401 REAUTH_REQUIRED");
    expect(outcomeOf(withoutMfa)).toBe("403 MFA_REQUIRED");
    expect(notOwner.map(outcomeOf)).toEqual(Array(4).fill("403 FORBIDDEN"));
    expect(outcomeOf(stranger)).toBe("404 NOT_FOUND");
    expect(outcomeOf(switchedOff)).toBe("403 FEATURE_DISABLED");
    expect(errorOf(switchedOff).details).toEqual({ feature: "settlements" });
    for (const res of [withoutStepUp, withoutMfa, ...notOwner, stranger, switchedOff]) {
      expectResponseToMatch("setPayoutAccount", res, { document: "platform" });
    }
    expect(await storedRow(f.tenant.id)).toBeUndefined();
    expect(await auditOf(f.tenant.id, "payout_account.updated")).toEqual([]);
    expect(await emailsOf(f.tenant.id, "ops.alert")).toEqual([]);
  });

  it("answers 404 without an account, 403 to admins, agents and viewers, and 404 to strangers", async () => {
    const f = await fixture();

    const none = await t.http.get(path(f)).set(await portal(f, "owner", false));
    expect(outcomeOf(none)).toBe("404 NOT_FOUND");
    expectResponseToMatch("getPayoutAccount", none, { document: "platform" });

    expect(outcomeOf(await setAccount(f, localBody()))).toBe("200");
    const others = await Promise.all(
      (["admin", "agent", "viewer", "stranger"] as const).map(async (who) =>
        t.http.get(path(f)).set(await portal(f, who, false)),
      ),
    );
    expect(others.map(outcomeOf)).toEqual([
      "403 FORBIDDEN",
      "403 FORBIDDEN",
      "403 FORBIDDEN",
      "404 NOT_FOUND",
    ]);
  });
});

describe("the payout account in the platform admin", () => {
  it("[PBE-058 AC2] reveals the bank details only with a reason and a step-up, no-store, and audits each reveal without a number", async () => {
    const f = await fixture();
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");
    const reason = "Bank transfer of the approved February 2027 statement.";

    const withoutStepUp = await reveal(f.tenant.id, { reason }, false);
    const withoutReason = await reveal(f.tenant.id, {});
    const shortReason = await reveal(f.tenant.id, { reason: "pay" });
    // Five characters for the request schema, but no reason once the spaces are gone: the request validation trims
    // every admin reason before it counts it (FIX-W35-PLATFORM), so these are refused before the handler, as the
    // short one is (and, like it, without the handler's `no-store`: no error answer holds a bank number).
    const blankReasons = [
      await reveal(f.tenant.id, { reason: "     " }),
      await reveal(f.tenant.id, { reason: "   pay   " }),
    ];
    expect(outcomeOf(withoutStepUp)).toBe("401 REAUTH_REQUIRED");
    expect(outcomeOf(withoutReason)).toBe("400 VALIDATION_FAILED");
    expect(outcomeOf(shortReason)).toBe("400 VALIDATION_FAILED");
    for (const res of blankReasons) {
      expect(outcomeOf(res)).toBe("400 VALIDATION_FAILED");
      expect(errorOf(res).fieldErrors?.map(({ path: at, code }) => [at, code])).toEqual([
        ["/reason", "minLength"],
      ]);
      expect(errorOf(res).fieldErrors).toEqual(errorOf(shortReason).fieldErrors);
    }
    for (const res of [withoutStepUp, withoutReason, shortReason, ...blankReasons]) {
      expectResponseToMatch("adminRevealPayoutAccount", res, { document: "platform" });
      expectNoBankNumber(JSON.stringify(res.body));
    }
    expect(await auditOf(f.tenant.id, "payout_account.revealed")).toEqual([]);

    const res = await reveal(f.tenant.id, { reason });

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminRevealPayoutAccount", res, { document: "platform" });
    expect(res.body).toEqual({ iban: IBAN, bic: "WESTGB2L" });
    expect(res.headers["cache-control"]).toBe("no-store");
    const audit = await auditOf(f.tenant.id, "payout_account.revealed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin,
      target_type: "payout_account",
      target_id: f.tenant.id,
      details: { reason, scheme: "iban", version: 1 },
    });
    expectNoBankNumber(JSON.stringify(audit));
    expectLogsWithoutBankNumbers(
      "POST",
      "/v1/admin/tenants/:tenantId/payout-account/reveal",
      [200, 400, 401],
    );

    // Each reveal is audited, with the reason trimmed.
    expect(outcomeOf(await reveal(f.tenant.id, { reason: `  ${reason}  ` }))).toBe("200");
    const audits = await auditOf(f.tenant.id, "payout_account.revealed");
    expect(audits.map((row) => (row["details"] as { reason: string }).reason)).toEqual([reason, reason]);
  });

  it("[PBE-058 AC2] reveals a local account's numbers as typed, and answers 404 without an account", async () => {
    const f = await fixture();
    const reason = "Bank transfer of the approved March 2027 statement.";

    const none = await reveal(f.tenant.id, { reason });
    expect(outcomeOf(none)).toBe("404 NOT_FOUND");
    expectResponseToMatch("adminRevealPayoutAccount", none, { document: "platform" });
    // The handler sets `no-store` before the service runs, so the service's own refusals carry it too.
    expect(none.headers["cache-control"]).toBe("no-store");
    expect(await auditOf(f.tenant.id, "payout_account.revealed")).toEqual([]);

    expect(outcomeOf(await setAccount(f, localBody()))).toBe("200");
    const res = await reveal(f.tenant.id, { reason });
    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminRevealPayoutAccount", res, { document: "platform" });
    expect(res.body).toEqual({ accountNumber: ACCOUNT_NUMBER, routingNumber: ROUTING_NUMBER });
  });

  it("answers the masked account with its ETag, 404 without one, and 401 to a portal token", async () => {
    const f = await fixture();
    const none = await t.http.get(adminPath(f.tenant.id)).set(await adminHeaders(false));
    expect(outcomeOf(none)).toBe("404 NOT_FOUND");
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");

    const res = await t.http.get(adminPath(f.tenant.id)).set(await adminHeaders(false));
    const portalToken = await t.http.get(adminPath(f.tenant.id)).set(await portal(f, "owner"));

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminGetPayoutAccount", res, { document: "platform" });
    expect(res.body).toMatchObject({ scheme: "iban", last4: "5432", status: "pending_review", version: 1 });
    expect(res.headers["etag"]).toBe('"1"');
    expectNoBankNumber(JSON.stringify(res.body));
    expect(outcomeOf(portalToken)).toBe("401 UNAUTHENTICATED");
    for (const answer of [none, portalToken]) {
      expectResponseToMatch("adminGetPayoutAccount", answer, { document: "platform" });
    }
  });

  it("[PBE-058 AC2] review sets the status with If-Match, audits it and e-mails every active owner payouts.reviewed", async () => {
    const f = await fixture();
    // Owners who get no e-mail: a removed and a suspended membership, and the active membership of a disabled account.
    await insertMembership(pool, f.tenant, await insertAccount(pool), { role: "owner", status: "removed" });
    await insertMembership(pool, f.tenant, await insertAccount(pool), { role: "owner", status: "suspended" });
    await insertMember(pool, f.tenant, await insertAccount(pool, { status: "disabled" }), "owner");
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");

    const res = await review(f.tenant.id, '"1"', { decision: "verified" });

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminReviewPayoutAccount", res, { document: "platform" });
    expect(res.body).toMatchObject({ status: "verified", reviewNote: null, version: 2 });
    expect(res.headers["etag"]).toBe('"2"');
    expect(await storedRow(f.tenant.id)).toMatchObject({
      status: "verified",
      reviewed_by_account_id: admin,
      reviewed_at: t.clock.now(),
      version: 2,
    });
    const audit = await auditOf(f.tenant.id, "payout_account.reviewed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin,
      target_id: f.tenant.id,
      details: {
        decision: "verified",
        version: 2,
        before: { status: "pending_review", reviewNote: null },
        after: { status: "verified", reviewNote: null },
      },
    });

    // The active owners (with and without MFA), never the other members nor the inactive owners.
    const emails = await emailsOf(f.tenant.id, "payouts.reviewed");
    expect(emails.map((email) => email.to_email).sort()).toEqual(
      [person(f, "owner").email, person(f, "ownerWithoutMfa").email].sort(),
    );
    for (const email of emails) {
      expect(email.data).toMatchObject({
        tenantName: f.tenant.name,
        tenantKey: f.tenant.key,
        outcome: "verified",
      });
      const text = rendered(email);
      expect(text).toContain(`${t.config.PUBLIC_PORTAL_URL}/otas/${f.tenant.id}/payments/payout-account`);
      expectNoBankNumber(text);
    }

    // The portal shows the review.
    const read = await t.http.get(path(f)).set(await portal(f, "finance", false));
    expect(read.body).toMatchObject({ status: "verified", reviewNote: null, version: 2 });
  });

  it("[PBE-058 AC2] a rejection needs a note, which the owner reads in the portal but not in the e-mail", async () => {
    const f = await fixture();
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");
    const note = "The holder name does not match the OTA's legal name; enter the company's own account.";

    const withoutNote = await review(f.tenant.id, '"1"', { decision: "rejected" });
    const noteOnVerify = await review(f.tenant.id, '"1"', { decision: "verified", note });
    const blankNote = await review(f.tenant.id, '"1"', { decision: "rejected", note: "   " });
    for (const refused of [withoutNote, noteOnVerify, blankNote]) {
      expect(outcomeOf(refused)).toBe("400 VALIDATION_FAILED");
      expectResponseToMatch("adminReviewPayoutAccount", refused, { document: "platform" });
    }
    expect(await auditOf(f.tenant.id, "payout_account.reviewed")).toEqual([]);

    const res = await review(f.tenant.id, '"1"', { decision: "rejected", note });

    expect(outcomeOf(res)).toBe("200");
    expectResponseToMatch("adminReviewPayoutAccount", res, { document: "platform" });
    expect(res.body).toMatchObject({ status: "rejected", reviewNote: note, version: 2 });
    const read = await t.http.get(path(f)).set(await portal(f, "owner", false));
    expect(read.body).toMatchObject({ status: "rejected", reviewNote: note });
    const emails = await emailsOf(f.tenant.id, "payouts.reviewed");
    expect(emails).toHaveLength(2);
    for (const email of emails) {
      expect(email.data["outcome"]).toBe("rejected");
      expect(rendered(email)).not.toContain(note);
    }
  });

  it("answers 412 to a stale If-Match (the owner changed the account meanwhile), and a review it already has changes nothing", async () => {
    const f = await fixture();
    expect(outcomeOf(await setAccount(f, ibanBody()))).toBe("200");
    // The admin read version 1; the owner replaces the account before the review arrives.
    expect(outcomeOf(await setAccount(f, localBody()))).toBe("200");

    const stale = await review(f.tenant.id, '"1"', { decision: "verified" });

    expect(outcomeOf(stale)).toBe("412 PRECONDITION_FAILED");
    expectResponseToMatch("adminReviewPayoutAccount", stale, { document: "platform" });
    expect(await storedRow(f.tenant.id)).toMatchObject({ status: "pending_review", version: 2 });
    expect(await auditOf(f.tenant.id, "payout_account.reviewed")).toEqual([]);
    expect(await emailsOf(f.tenant.id, "payouts.reviewed")).toEqual([]);

    expect(outcomeOf(await review(f.tenant.id, '"2"', { decision: "verified" }))).toBe("200");
    const again = await review(f.tenant.id, '"3"', { decision: "verified" });
    expect(outcomeOf(again)).toBe("200");
    expect(again.body).toMatchObject({ status: "verified", version: 3 });
    expect(await auditOf(f.tenant.id, "payout_account.reviewed")).toHaveLength(1);
    expect(await emailsOf(f.tenant.id, "payouts.reviewed")).toHaveLength(2);

    const unknown = await review(testId("ten", 9999), '"1"', { decision: "verified" });
    expect(outcomeOf(unknown)).toBe("404 NOT_FOUND");
    expectResponseToMatch("adminReviewPayoutAccount", unknown, { document: "platform" });
  });
});
