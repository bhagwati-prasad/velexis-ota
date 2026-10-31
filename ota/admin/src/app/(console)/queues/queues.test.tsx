// The queue pages `/queues` and `/queues/[queueId]` as Next.js renders them on the server (OAD-009): the real pages,
// `getConsoleRequest` and the SDK against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a
// detached happy-dom document (a server-mode SDK client refuses to run in a browser-like test environment, rightly). It
// checks the requests a URL sends (the stored snapshots, "Read now", the cursor of a later page), what the pages show
// (the queues with their last read, the PNRs with their bookings, the orphans with "Import" to the PNR lookup) and the
// API's codes handled on the server.
import type { QueueItem, QueueSnapshot } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

// ---- Mocks: the request scope and navigation of Next.js and the configuration ------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/queues",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import { formatInstant } from "@/app/(console)/bookings/views";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import QueuePage from "./[queueId]/page";
import QueuesPage from "./page";

const ME = "GET /v1/console/auth/me";
const SNAPSHOTS = "GET /v1/console/queue-snapshots";
const QUEUE = (queueId: number) => `GET /v1/console/queues/${queueId}`;
const TIME_ZONE = "Europe/Oslo";
const OFFICE = "OSLN12345";
const OTHER_OFFICE = "OSLN54321";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`queues-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-queues-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** A PNR of a queue (dummy data): linked to booking VX7K2Q, or an orphan. */
function item(recordLocator: string, booking: "linked" | "orphan"): QueueItem {
  return {
    pnrId: `${recordLocator}-2026-10-09`,
    recordLocator,
    creationDateTime: "2026-10-09T17:44:00",
    travelers: [{ firstName: "CLAIRE", lastName: "MOREAU" }],
    segments: [
      { carrierCode: "AF", number: "6", arrivalIataCode: "JFK", arrivalLocalDateTime: "2026-11-20T12:45:00" },
    ],
    bookingId: booking === "linked" ? BOOKING_ID : null,
    bookingReference: booking === "linked" ? "VX7K2Q" : null,
    bookingStatus: booking === "linked" ? "ticketed" : null,
    amadeus: { type: "pnr", id: `${recordLocator}-2026-10-09` },
  } as unknown as QueueItem;
}

/** A stored read of a queue (dummy data): the poller's by default. */
function snapshot(overrides: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    id: "qsn_01JA4E9X2A5D8G1J4M7P0S3V6Y",
    environment: "test",
    officeId: OFFICE,
    queueId: 50,
    category: 0,
    maxRequested: null,
    itemCount: 2,
    fetchedAt: "2026-10-10T09:45:00Z",
    fetchedBy: null,
    supplierRequestId: "sreq_01JA4E9X1Z4C7F0H3K6N9Q2T5W",
    warnings: [],
    ...overrides,
  };
}

const STAFF_READER = {
  type: "staff",
  id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
  name: "Maria Lopez",
  email: "maria.lopez@example.com",
  role: "agent",
} as const;

/** `console.queues.listSnapshots` answers `data` (whatever the query). */
function snapshotsAnswer(data: QueueSnapshot[]): void {
  api.on(SNAPSHOTS, () => Response.json({ data, page: { nextCursor: null, limit: data.length } }));
}

/** `console.queues.list` of queue 50 answers a fresh read with `items` and `nextCursor`. */
function queueAnswer(items: QueueItem[], nextCursor: string | null = null): void {
  api.on(QUEUE(50), () =>
    Response.json({
      data: items,
      page: { nextCursor, limit: 50 },
      snapshot: snapshot({
        id: "qsn_01JA4G2M5P8S1V4Y7B0E3H6K9N",
        fetchedAt: "2026-10-10T10:00:03Z",
        fetchedBy: STAFF_READER,
        itemCount: 120,
        maxRequested: null,
      }),
      warnings: [],
    }),
  );
}

/** Renders `element` to HTML on the "server" and parses it into a document. */
function toDocument(element: ReactElement): HTMLElement {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The search parameters of `search` as Next.js hands them to a page. */
function searchParamsOf(search: string): Promise<Record<string, string | string[]>> {
  const query = new URLSearchParams(search);
  const params: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    params[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return Promise.resolve(params);
}

async function renderQueues(search = ""): Promise<HTMLElement> {
  return toDocument(await QueuesPage({ searchParams: searchParamsOf(search) }));
}

async function renderQueue(queueId: string, search = ""): Promise<HTMLElement> {
  return toDocument(
    await QueuePage({ params: Promise.resolve({ queueId }), searchParams: searchParamsOf(search) }),
  );
}

/** The query of each request of `route`, as plain objects. */
function queriesOf(route: string): Record<string, string>[] {
  return api.sent(route).map((request: SentRequest) => Object.fromEntries(request.url.searchParams));
}

/** The PNR row of `recordLocator`. */
function rowOf(page: HTMLElement, recordLocator: string): HTMLElement {
  const row = page.querySelector<HTMLElement>(`tr[data-record-locator="${recordLocator}"]`);
  if (row === null) {
    throw new Error(`no row for ${recordLocator}`);
  }
  return row;
}

// Once per file: the first server render of a page and the SDK's first calls are the slowest in a fresh worker; on a
// busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  snapshotsAnswer([snapshot({ items: [item("L2P9XC", "orphan")] })]);
  await renderQueues();
  await renderQueue("50");
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

describe("/queues/[queueId]", () => {
  it("[OAD-009 AC2] Read now reads Amadeus once; a PNR links to its booking and an orphan to /pnr?recordLocator=…", async () => {
    queueAnswer([item("ABC123", "linked"), item("L2P9XC", "orphan")], "cursor_page_2");
    snapshotsAnswer([]);

    const page = await renderQueue("50", "officeId=OSLN12345&category=0&read=1");

    expect(queriesOf(QUEUE(50))).toEqual([{ officeId: OFFICE, category: "0", limit: "50" }]);
    expect(api.sent(QUEUE(50))[0]?.headers.get("X-Velexis-Environment")).toBe("test");
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Queue 50");
    expect(page.textContent).toContain(
      `Read from Amadeus at ${formatInstant("2026-10-10T10:00:03Z", TIME_ZONE)} by Maria Lopez (office ${OFFICE}, category 0): 120 PNRs.`,
    );

    const linked = rowOf(page, "ABC123");
    expect(within(linked).getByRole("link", { name: "VX7K2Q" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}`,
    );
    expect(linked.textContent).toContain("Ticketed");
    expect(within(linked).queryByRole("link", { name: /Import/ })).toBeNull();

    const orphan = rowOf(page, "L2P9XC");
    expect(orphan.textContent).toContain("No booking");
    expect(within(orphan).getByRole("link", { name: "Import L2P9XC" }).getAttribute("href")).toBe(
      "/pnr?recordLocator=L2P9XC",
    );
    expect(orphan.textContent).toContain("MOREAU/CLAIRE");
    expect(orphan.textContent).toContain("AF 6 → JFK, Nov 20, 2026, 12:45");

    // The next page comes from the stored read, its office and category kept.
    const pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(within(pages).getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/queues/50?officeId=OSLN12345&category=0&cursor=cursor_page_2",
    );
  });

  it("[OAD-009 AC2] shows the last stored read without calling Amadeus, its orphans linked to /pnr?recordLocator=…", async () => {
    // A URL without an office or a category shows the newest read of any of them: the line names the read's own.
    snapshotsAnswer([
      snapshot({
        officeId: OTHER_OFFICE,
        category: 3,
        items: [item("XYZ789", "orphan"), item("ABC123", "linked")],
      }),
    ]);

    const page = await renderQueue("50");

    expect(api.sent(QUEUE(50))).toHaveLength(0);
    // The stored read with its items, then the earlier reads.
    expect(queriesOf(SNAPSHOTS)).toEqual([
      { queueId: "50", limit: "1", include: "items" },
      { queueId: "50", limit: "10" },
    ]);
    expect(page.textContent).toContain(
      `Last stored read, at ${formatInstant("2026-10-10T09:45:00Z", TIME_ZONE)} by Scheduled poller (office ${OTHER_OFFICE}, category 3): 2 PNRs.`,
    );
    expect(
      within(rowOf(page, "XYZ789")).getByRole("link", { name: "Import XYZ789" }).getAttribute("href"),
    ).toBe("/pnr?recordLocator=XYZ789");
    expect(within(rowOf(page, "ABC123")).getByRole("link", { name: "VX7K2Q" })).toBeTruthy();
    // "Read now" is a GET form to this queue.
    const read = within(page).getByRole("button", { name: "Read now from Amadeus" }).closest("form");
    expect(read?.getAttribute("method")).toBe("get");
    expect(read?.getAttribute("action")).toBe("/queues/50");
    expect(read?.querySelector<HTMLInputElement>('input[name="read"]')?.getAttribute("value")).toBe("1");
    const history = within(page).getByRole("table", { name: "Stored reads of queue 50" });
    expect([...history.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      formatInstant("2026-10-10T09:45:00Z", TIME_ZONE),
      "Scheduled poller",
      "2",
      OTHER_OFFICE,
      "3",
    ]);
  });

  it("pages a fresh read with the API's cursor, and asks to open the queue again when the cursor is refused", async () => {
    queueAnswer([item("DEF456", "orphan")]);
    snapshotsAnswer([]);

    await renderQueue("50", "officeId=OSLN12345&category=0&cursor=cursor_page_2");
    expect(queriesOf(QUEUE(50))).toEqual([
      { officeId: OFFICE, category: "0", limit: "50", cursor: "cursor_page_2" },
    ]);

    api.on(QUEUE(50), () =>
      apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/query/cursor", code: "invalid" }] }),
    );
    const page = await renderQueue("50", "cursor=cursor_page_2");
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("This page of the read is no longer available");
    expect(within(alert).getByRole("link", { name: "Queue 50" }).getAttribute("href")).toBe("/queues/50");
  });

  it("names the parameters the API would refuse and treats an unknown queue number as not found, without a request", async () => {
    let page = await renderQueue("50", "officeId=nce&category=999");
    expect(within(page).getByRole("alert").textContent).toContain("Not valid: Office, Category.");
    page = await renderQueue("100");
    expect(within(page).getByRole("alert").textContent).toContain("No such queue");
    page = await renderQueue("q50");
    expect(within(page).getByRole("alert").textContent).toContain("No such queue");
    expect(api.requests.filter((request) => request.url.pathname !== "/v1/console/auth/me")).toEqual([]);
  });

  it("renders OFFICE_NOT_ALLOWED and the supplier's errors on the server, and redirects an expired session to the stored view", async () => {
    snapshotsAnswer([]);
    api.on(QUEUE(50), () => apiError("OFFICE_NOT_ALLOWED", 403));
    let page = await renderQueue("50", "officeId=PARXX0000&read=1");
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("This Amadeus office is not one of this OTA's offices.");
    expect(alert.textContent).toContain("req_fake_1");

    api.on(QUEUE(50), () => apiError("SUPPLIER_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));
    page = await renderQueue("50", "read=1");
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Amadeus is unavailable right now.");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/queues/50?read=1",
    );

    api.on(QUEUE(50), () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/queues/50?category=0" }).toString();
    expect(await redirectOf(() => renderQueue("50", "category=0&read=1"))).toBe(`/auth/refresh?${next}`);
  });

  it("refuses a role without queues:read before any queue request", async () => {
    api.on(ME, () => Response.json(staffProfile({ role: "finance" })));

    const page = await renderQueue("50", "read=1");

    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (queues:read).",
    );
    expect(api.sent(QUEUE(50))).toHaveLength(0);
    expect(api.sent(SNAPSHOTS)).toHaveLength(0);
  });
});

describe("/queues", () => {
  it("lists each queue's newest read, marks the ones the scheduled poller reads, and links each queue", async () => {
    snapshotsAnswer([
      snapshot({
        id: "qsn_01JA4G2M5P8S1V4Y7B0E3H6K9A",
        fetchedAt: "2026-10-10T10:00:03Z",
        fetchedBy: STAFF_READER,
        itemCount: 3,
      }),
      snapshot({
        id: "qsn_01JA4G2M5P8S1V4Y7B0E3H6K9B",
        queueId: 8,
        fetchedAt: "2026-10-10T09:50:00Z",
        fetchedBy: STAFF_READER,
        itemCount: 0,
      }),
      snapshot({ id: "qsn_01JA4G2M5P8S1V4Y7B0E3H6K9C", fetchedAt: "2026-10-10T09:45:00Z" }),
    ]);

    const page = await renderQueues();

    expect(queriesOf(SNAPSHOTS)).toEqual([{ limit: "100" }]);
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Queues");
    const table = within(page).getByRole("table", { name: "Queues read recently" });
    const rows = [...table.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["Queue 8", OFFICE, "0", formatInstant("2026-10-10T09:50:00Z", TIME_ZONE), "Maria Lopez", "0", "No"],
      [
        "Queue 50",
        OFFICE,
        "0",
        formatInstant("2026-10-10T10:00:03Z", TIME_ZONE),
        "Maria Lopez",
        "3",
        "Yes, by the scheduled poller",
      ],
    ]);
    expect(within(table).getByRole("link", { name: "Queue 50" }).getAttribute("href")).toBe(
      "/queues/50?officeId=OSLN12345&category=0",
    );
  });

  it("opens a queue from the form: a valid queue goes to its page, an invalid one is named without a request", async () => {
    expect(await redirectOf(() => renderQueues("queueId=50&category=0&officeId=osln12345"))).toBe(
      "/queues/50?officeId=OSLN12345&category=0",
    );
    expect(await redirectOf(() => renderQueues("queueId=7&category=&officeId="))).toBe("/queues/7");

    snapshotsAnswer([]);
    const page = await renderQueues("queueId=150&category=x&officeId=PARXX0000");
    const form = within(page).getByRole("form", { name: "Open a queue" });
    expect(form.getAttribute("method")).toBe("get");
    expect(form.textContent).toContain("Enter a queue number from 0 to 99.");
    expect(form.textContent).toContain("Enter a category from 0 to 254.");
    expect(form.textContent).toContain("Choose one of this OTA's offices.");
    expect(within(form).getByLabelText("Queue number").getAttribute("aria-invalid")).toBe("true");
    expect(api.requests.some((request) => request.url.pathname.startsWith("/v1/console/queues/"))).toBe(
      false,
    );
  });

  it("says when no queue was read yet, and renders the API's refusals with a retry", async () => {
    snapshotsAnswer([]);
    let page = await renderQueues();
    expect(page.textContent).toContain("No queue has been read in this environment yet.");

    api.on(SNAPSHOTS, () =>
      apiError("RATE_LIMITED", 429, { details: { retryAfterSeconds: 60 } }, { "Retry-After": "60" }),
    );
    page = await renderQueues();
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Too many requests, retry in 60 s.");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/queues");

    api.on(SNAPSHOTS, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderQueues())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });
});
