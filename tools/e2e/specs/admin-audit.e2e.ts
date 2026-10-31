// The platform audit log from the platform admin: filters in the URL and the CSV export (PAD-010 step 4;
// flows/platform-admin-operations.md §I, PADR-0006 "Audit"; PF-85): an OTA created through the portal API by its owner,
// whose internal notes the admin edits, so the OTA has rows of both a portal user and a platform admin.
//
//   the admin edits the OTA's notes → filters the audit log by the OTA and a period → narrows it by action and actor,
//   every filter in the URL → downloads the CSV of the narrowed rows → finds the export itself in the audit log
//
// The journey needs no OTA worker; with `E2E_WITH_OTA=1` the OTA is set up meanwhile, which writes rows and a new
// version of its own, so the journey waits for the set-up's end before it edits (an edit sends the version in
// `If-Match`). The steps are tests in order (`mode: "serial"`): a failed step stops the rest. Every page the journey
// visits passes `expectNoSeriousA11yViolations` once its title is in place. The period covers yesterday to tomorrow
// (UTC), so the journey's rows are in it whenever it runs, midnight included; no date is fixed.
import { readFile } from "node:fs/promises";
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  signInWithApi,
  test,
  type MfaAccount,
  type PortalAccount,
} from "../support/fixtures";
import { buildAccount, grantPlatformAdmin, stack } from "../support/seed";
import { PLATFORM_ADMIN_URL } from "../support/stack";
import { createOtaWithApi, waitForOtaStatus, type Ota } from "../support/tenants";

test.describe.configure({ mode: "serial" });

/** Waits until `target` shows the admin page `title`, then runs axe. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(`${title} · Velexis admin`);
  await expectNoSeriousA11yViolations(target);
}

/** The columns of `adminExportAudit`'s file, in the order of the platform document. */
const CSV_COLUMNS = [
  "id",
  "createdAt",
  "tenantId",
  "tenantKey",
  "actorType",
  "actorAccountId",
  "actorLabel",
  "action",
  "targetType",
  "targetId",
  "requestId",
  "ipAddress",
  "userAgent",
  "details",
];

/** The records of an RFC 4180 file (quoted cells with doubled quotes, CRLF line ends), each as its cells. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(cell);
      cell = "";
    } else if (char === "\r" && text[index + 1] === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      index += 1;
    } else {
      cell += char;
    }
  }
  if (cell !== "" || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

/** The instant the journey's period is computed from, once: a run across midnight keeps the same days. */
const TODAY = new Date();

/** A UTC day `offset` days from TODAY, as `<input type="date">` and the API take it (`YYYY-MM-DD`). */
function utcDay(offset: number): string {
  const day = new Date(TODAY.getTime());
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

const FROM = utcDay(-1);
const TO = utcDay(1);
/** The end of the period the API exports: the day after TO (exclusive). */
const END = utcDay(2);
const NOTES = "Signed the reseller agreement on the phone (PAD-010 journey).";

let owner: PortalAccount;
let admin: MfaAccount;
let ota: Ota;
let adminContext: BrowserContext;
let adminPage: Page;
/** The admin's account id, read from the actor link of their audit row. */
let adminAccountId: string;

test.beforeAll(async ({ browser }) => {
  // Budget: two sign-ups with their verification e-mails (up to 15 s each, in parallel), an MFA set-up, `admin:grant`
  // through the platform CLI and, with E2E_WITH_OTA=1, the OTA's set-up (about 2 s locally; PF-11 allows a minute).
  test.setTimeout(90_000);
  const [ownerAccount, adminAccount] = await Promise.all([
    createVerifiedAccount(buildAccount({ fullName: "Otto Owner" })),
    createVerifiedAccount(buildAccount({ fullName: "Ada Admin" })).then(enableMfa),
  ]);
  owner = ownerAccount;
  admin = adminAccount;
  const signedInOwner = { account: owner, accessToken: (await signInWithApi(owner)).accessToken };
  const created = await createOtaWithApi(signedInOwner, { name: "Audit Travel" });
  await grantPlatformAdmin(admin.email);
  // Without the OTA worker the set-up job waits and the OTA stays in set-up, unchanged.
  ota = await waitForOtaStatus(
    signedInOwner,
    created.id,
    stack().settings.E2E_WITH_OTA ? "active" : "provisioning",
  );

  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", await signInToAdminWithApi(admin));
  adminPage = await adminContext.newPage();
});

test.afterAll(async () => {
  await adminContext.close();
});

test("the admin edits the OTA's internal notes [PAD-010 AC1]", async () => {
  await adminPage.goto(`/tenants/${ota.id}`);
  await adminPage.getByRole("button", { name: "Edit notes and legal name" }).click();
  await adminPage.getByRole("textbox", { name: "Internal notes" }).fill(NOTES);
  await expectNoSeriousA11yViolations(adminPage);
  await adminPage.getByRole("button", { name: "Save", exact: true }).click();
  await expect(adminPage.getByText("The notes and the legal name are saved.")).toBeVisible();
  await expect(adminPage.getByRole("region", { name: "Internal notes" })).toContainText(NOTES);
  await expectAccessible(adminPage, "Tenant");
});

test("filters the audit log by the OTA and a period, kept in the URL [PAD-010 AC1]", async () => {
  // The OTA's audit tab links the whole log of the OTA.
  await adminPage.getByRole("tab", { name: "Audit" }).click();
  await adminPage.getByRole("link", { name: "Full audit log of this OTA" }).click();
  await adminPage.waitForURL(
    (url) => url.pathname === "/audit" && url.searchParams.get("tenantId") === ota.id,
  );
  await expect(adminPage.getByLabel("OTA (tenant id)")).toHaveValue(ota.id);
  // Without a period there is no export yet.
  await expect(
    adminPage.getByText("Choose a period (from and to) to export: at most one year."),
  ).toBeVisible();

  await adminPage.getByLabel("From (UTC)").fill(FROM);
  await adminPage.getByLabel("To (UTC, included)").fill(TO);
  await adminPage.getByRole("button", { name: "Search" }).click();
  await adminPage.waitForURL(
    (url) => url.searchParams.get("from") === FROM && url.searchParams.get("to") === TO,
  );
  expect(new URL(adminPage.url()).searchParams.get("tenantId")).toBe(ota.id);

  // PF-85: only this OTA's rows, the owner's creation and the admin's edit among them.
  const table = adminPage.getByRole("table", { name: "Audit rows, newest first" });
  const rows = table.getByRole("row").filter({ has: adminPage.getByRole("cell") });
  await expect(rows.filter({ hasText: "tenant.created" })).toContainText(owner.email);
  await expect(rows.filter({ hasText: "tenant.created" })).toContainText("Portal user");
  const edit = rows.filter({ hasText: "tenant.updated" }).filter({ hasText: admin.email });
  await expect(edit).toHaveCount(1);
  await expect(edit).toContainText("Platform admin");
  // The second column names the OTA of each row.
  const otaCells = await rows.evaluateAll((elements) =>
    elements.map((element) => element.querySelectorAll("td")[1]?.textContent ?? ""),
  );
  expect(otaCells.length).toBeGreaterThanOrEqual(2);
  expect(new Set(otaCells)).toEqual(new Set([ota.key]));
  adminAccountId = new URL(
    (await edit.getByRole("link", { name: admin.email }).getAttribute("href")) ?? "",
    PLATFORM_ADMIN_URL,
  ).pathname.replace("/accounts/", "");
  expect(adminAccountId).toMatch(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/);
  await expectAccessible(adminPage, "Audit log");
});

test("narrows the rows by action and actor; the export link carries the same filters [PAD-010 AC1]", async () => {
  // Selects apply at once, and every filter stays in the URL.
  await adminPage.getByLabel("Action").selectOption("tenant.updated");
  await adminPage.waitForURL((url) => url.searchParams.get("action") === "tenant.updated");
  await adminPage.getByLabel("Actor", { exact: true }).selectOption("platform_admin");
  await adminPage.waitForURL((url) => url.searchParams.get("actorType") === "platform_admin");
  const url = new URL(adminPage.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    tenantId: ota.id,
    actorType: "platform_admin",
    action: "tenant.updated",
    from: FROM,
    to: TO,
  });
  const rows = adminPage
    .getByRole("table", { name: "Audit rows, newest first" })
    .getByRole("row")
    .filter({ has: adminPage.getByRole("cell") });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(NOTES);

  // A plain link (no prefetch, which would run the export) with the page's filters and no cursor.
  const download = adminPage.getByRole("link", { name: "Download CSV" });
  const href = new URL((await download.getAttribute("href")) ?? "", PLATFORM_ADMIN_URL);
  expect(href.pathname).toBe("/audit/export.csv");
  expect(Object.fromEntries(href.searchParams)).toEqual({
    tenantId: ota.id,
    actorType: "platform_admin",
    action: "tenant.updated",
    from: FROM,
    to: TO,
  });
  await expectAccessible(adminPage, "Audit log");
});

test("downloads the CSV of the narrowed rows [PAD-010 AC1]", async () => {
  const [download] = await Promise.all([
    adminPage.waitForEvent("download"),
    adminPage.getByRole("link", { name: "Download CSV" }).click(),
  ]);
  // The API's name: the first day and the end of the period (exclusive, the day after the last).
  expect(download.suggestedFilename()).toBe(`velexis-audit-${FROM}-${END}.csv`);
  const path = await download.path();
  const [header, ...records] = parseCsv(await readFile(path, "utf8"));
  expect(header).toEqual(CSV_COLUMNS);
  expect(records).toHaveLength(1);
  const row = Object.fromEntries(CSV_COLUMNS.map((column, index) => [column, records[0]?.[index]]));
  expect(row).toMatchObject({
    tenantId: ota.id,
    tenantKey: ota.key,
    actorType: "platform_admin",
    actorAccountId: adminAccountId,
    actorLabel: admin.email,
    action: "tenant.updated",
    targetType: "tenant",
    targetId: ota.id,
  });
  expect(row["details"]).toContain(NOTES);
});

test("the export itself is in the audit log [PAD-010 AC1]", async () => {
  // PF-85: an export is a sensitive read, audited with its filters; it belongs to no OTA.
  const query = new URLSearchParams({
    actorAccountId: adminAccountId,
    action: "audit.exported",
    from: FROM,
    to: TO,
  });
  await adminPage.goto(`/audit?${query.toString()}`);
  const rows = adminPage
    .getByRole("table", { name: "Audit rows, newest first" })
    .getByRole("row")
    .filter({ has: adminPage.getByRole("cell") });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Platform admin");
  await expect(rows).toContainText(ota.id);
  await expect(rows).toContainText("tenant.updated");
  await expectAccessible(adminPage, "Audit log");
});
