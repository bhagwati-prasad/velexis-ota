// @vitest-environment happy-dom
// The filters and the saved views of `/bookings` in the browser (OAD-006 AC1): they write the URL's search parameters
// and nothing else, through Next.js's router (mocked here), and `listParams` of views.ts turns that URL into the
// parameters of `console.bookings.list`. What the page's server component sends for a URL, with the real SDK and a
// fake `fetch`, is tested in page.test.tsx.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the navigation of Next.js ---------------------------------------------------------------------------

const navigation = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/bookings",
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
}));

import { BookingFilters, BookingViews, FILTER_STRINGS } from "./filters";
import {
  BOOKING_VIEWS,
  activeView,
  bookingsHref,
  dayStartIn,
  listParams,
  viewHref,
  type BookingView,
} from "./views";

const OSLO = "Europe/Oslo";
const HOUR = 3_600_000;

/** The URL the filters pushed last. */
function pushed(): string {
  const calls = navigation.router.push.mock.calls;
  return String(calls.at(-1)?.[0]);
}

/** What the page would send for `href` (views.ts), at `now` in Oslo. */
function paramsOf(href: string, now = 0) {
  return listParams(new URL(href, "http://admin.invalid").searchParams, { now, timeZone: OSLO });
}

function view(id: string): BookingView {
  const found = BOOKING_VIEWS.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no view ${id}`);
  }
  return found;
}

function filters(): HTMLElement {
  return screen.getByRole("search", { name: FILTER_STRINGS.filtersLabel });
}

// Once per file: the first render of the form (React DOM, next/link, Radix's label) is the slowest in a fresh worker;
// on a busy CI runner it would otherwise land in the first test's own five seconds. Nothing of it stays.
beforeAll(() => {
  render(
    <>
      <BookingViews />
      <BookingFilters />
    </>,
  );
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  navigation.searchParams = new URLSearchParams();
  navigation.router.push.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("BookingFilters", () => {
  it("[OAD-006 AC1] a status applies at once: the URL gets it, the cursor goes, the page size stays", () => {
    navigation.searchParams = new URLSearchParams(
      "limit=50&cursor=c_9&asOf=2026-10-23T08%3A00%3A00.000Z&q=berg",
    );
    render(<BookingFilters />);

    fireEvent.click(within(filters()).getByRole("checkbox", { name: "Confirmed" }));

    expect(navigation.router.push).toHaveBeenCalledTimes(1);
    expect(navigation.router.push).toHaveBeenCalledWith("/bookings?limit=50&q=berg&status=confirmed", {
      scroll: false,
    });
    // ... and the server request follows the URL: the new filter, no cursor, the same page size.
    expect(paramsOf(pushed())).toEqual({
      params: { limit: 50, q: "berg", status: ["confirmed"] },
      invalid: [],
    });
  });

  it("[OAD-006 AC1] a second choice adds to the first; the sort and the yes/no filters apply at once", () => {
    navigation.searchParams = new URLSearchParams("status=confirmed");
    const { rerender } = render(<BookingFilters />);
    /** Next.js navigates to the pushed URL and renders the filters again with its search parameters. */
    const navigate = () => {
      navigation.searchParams = new URL(pushed(), "http://admin.invalid").searchParams;
      rerender(<BookingFilters />);
    };

    fireEvent.click(within(filters()).getByRole("checkbox", { name: "Partially ticketed" }));
    expect(pushed()).toBe("/bookings?status=confirmed&status=partially_ticketed");
    navigate();

    fireEvent.change(within(filters()).getByLabelText("Sort"), { target: { value: "ticketingDeadline" } });
    expect(pushed()).toBe("/bookings?status=confirmed&status=partially_ticketed&sort=ticketingDeadline");
    navigate();

    fireEvent.change(within(filters()).getByLabelText("Schedule changed"), { target: { value: "true" } });
    expect(pushed()).toBe(
      "/bookings?status=confirmed&status=partially_ticketed&sort=ticketingDeadline&hasScheduleChange=true",
    );
    expect(paramsOf(pushed()).params).toEqual({
      limit: 25,
      status: ["confirmed", "partially_ticketed"],
      sort: "ticketingDeadline",
      hasScheduleChange: true,
    });
    navigate();

    // Unticking a choice removes it; the default sort is no parameter.
    fireEvent.click(within(filters()).getByRole("checkbox", { name: "Confirmed" }));
    expect(pushed()).toBe(
      "/bookings?status=partially_ticketed&sort=ticketingDeadline&hasScheduleChange=true",
    );
    navigate();
    fireEvent.change(within(filters()).getByLabelText("Sort"), { target: { value: "" } });
    expect(pushed()).toBe("/bookings?status=partially_ticketed&hasScheduleChange=true");
    expect(navigation.router.push).toHaveBeenCalledTimes(5);
  });

  it("[OAD-006 AC1] text and days apply on submit, as the API wants them", () => {
    navigation.searchParams = new URLSearchParams("ticketingStatus=failed");
    render(<BookingFilters />);
    const form = filters();

    fireEvent.change(within(form).getByLabelText("Search"), { target: { value: "  berg " } });
    fireEvent.change(within(form).getByLabelText("Record locator"), { target: { value: "t5n2kd" } });
    fireEvent.change(within(form).getByLabelText("Created from"), { target: { value: "2026-10-01" } });
    expect(navigation.router.push).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole("button", { name: FILTER_STRINGS.apply }));

    expect(pushed()).toBe(
      "/bookings?q=berg&ticketingStatus=failed&recordLocator=T5N2KD&createdFrom=2026-10-01",
    );
    expect(paramsOf(pushed()).params).toEqual({
      limit: 25,
      q: "berg",
      ticketingStatus: ["failed"],
      recordLocator: "T5N2KD",
      createdFrom: dayStartIn("2026-10-01", OSLO),
    });
  });

  it("[OAD-006 AC1] a value the API would refuse stays at its field and is never written", () => {
    render(<BookingFilters />);
    const form = filters();

    const search = within(form).getByLabelText("Search");
    fireEvent.change(search, { target: { value: "b" } });
    fireEvent.change(within(form).getByLabelText("Validating airline"), { target: { value: "a" } });
    fireEvent.submit(form);

    expect(navigation.router.push).not.toHaveBeenCalled();
    expect(search.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(search.getAttribute("aria-describedby") ?? "");
    expect(message?.textContent).toBe("Enter at least 2 characters.");
    expect(within(form).getByText("Enter the airline's 2-character IATA code.")).toBeTruthy();

    fireEvent.change(search, { target: { value: "bo" } });
    fireEvent.change(within(form).getByLabelText("Validating airline"), { target: { value: "af" } });
    fireEvent.submit(form);
    expect(pushed()).toBe("/bookings?q=bo&validatingCarrier=AF");
  });

  it("follows the URL: a saved view or the back button resets the fields", () => {
    navigation.searchParams = new URLSearchParams("q=berg");
    const { rerender } = render(<BookingFilters />);
    expect((within(filters()).getByLabelText("Search") as HTMLInputElement).value).toBe("berg");

    navigation.searchParams = new URLSearchParams(viewHref(view("cancelled")).split("?")[1]);
    rerender(<BookingFilters />);

    expect((within(filters()).getByLabelText("Search") as HTMLInputElement).value).toBe("");
    const cancelled = within(filters()).getByRole("checkbox", { name: "Cancelled" }) as HTMLInputElement;
    expect(cancelled.checked).toBe(true);
    expect(within(filters()).getByText("Cancelled", { selector: "summary span" })).toBeTruthy();
  });

  it("clears every filter but keeps the page size; a filter only a link sets is a chip that removes itself", () => {
    navigation.searchParams = new URLSearchParams(
      "customerId=cus_8f3K2mQ9xT4vB7nL&status=confirmed&limit=50&cursor=c_2",
    );
    render(<BookingFilters />);
    const form = filters();

    expect(within(form).getByRole("link", { name: FILTER_STRINGS.clear }).getAttribute("href")).toBe(
      "/bookings?limit=50",
    );
    expect(
      within(form)
        .getByRole("link", { name: FILTER_STRINGS.remove("Customer") })
        .getAttribute("href"),
    ).toBe("/bookings?limit=50&status=confirmed");
    // A choice keeps the link's filter.
    fireEvent.click(within(form).getByRole("checkbox", { name: "Ticketed" }));
    expect(pushed()).toBe(
      "/bookings?limit=50&status=confirmed&status=ticketed&customerId=cus_8f3K2mQ9xT4vB7nL",
    );
  });

  it("shows a link-only filter the API would refuse on its chip, which removes it", () => {
    navigation.searchParams = new URLSearchParams("customerId=nope&status=confirmed");
    render(<BookingFilters />);
    const form = filters();

    expect(within(form).getByText("Not a customer id.")).toBeTruthy();
    expect(
      within(form)
        .getByRole("link", { name: FILTER_STRINGS.remove("Customer") })
        .getAttribute("href"),
    ).toBe("/bookings?status=confirmed");
    // Until then nothing else is written: the link's value would be refused.
    fireEvent.click(within(form).getByRole("checkbox", { name: "Ticketed" }));
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("works as a plain GET form to the same page without JavaScript", () => {
    navigation.searchParams = new URLSearchParams(
      "limit=50&cursor=c_2&asOf=2026-10-23T08%3A00%3A00.000Z&customerId=cus_8f3K2mQ9xT4vB7nL",
    );
    render(<BookingFilters />);
    const form = filters() as HTMLFormElement;

    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/bookings");
    const hidden = [...form.querySelectorAll('input[type="hidden"]')].map((input) => [
      input.getAttribute("name"),
      input.getAttribute("value"),
    ]);
    expect(hidden).toEqual([
      ["limit", "50"],
      ["customerId", "cus_8f3K2mQ9xT4vB7nL"],
    ]);
  });
});

describe("BookingViews", () => {
  it("[OAD-006] links every saved view with its preset filters and marks the one the URL shows", () => {
    navigation.searchParams = new URLSearchParams("ticketingStatus=manual_review,failed");
    render(<BookingViews />);

    const nav = screen.getByRole("navigation", { name: FILTER_STRINGS.viewsLabel });
    const links = within(nav)
      .getAllByRole("link")
      .map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Ticketing problems", "/bookings?ticketingStatus=failed&ticketingStatus=manual_review"],
      ["Reconciliation review", "/bookings?reconcileOutcome=manual_review"],
      [
        "Deadline within 24 h",
        "/bookings?status=confirmed&status=partially_ticketed&sort=ticketingDeadline&deadlineWithin=24h",
      ],
      ["Cancellation requested", "/bookings?cancellationRequested=true"],
      ["Schedule changed", "/bookings?hasScheduleChange=true"],
      ["All bookings", "/bookings"],
      ["To issue", "/bookings?status=confirmed&status=partially_ticketed&sort=ticketingDeadline"],
      ["Reconciling", "/bookings?status=pending"],
      ["Cancelled", "/bookings?status=cancelled"],
      ["Imported", "/bookings?source=import"],
    ]);
    // The URL lists the two statuses in another order and comma-separated: still the same view.
    expect(within(nav).getByRole("link", { name: "Ticketing problems" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.hasAttribute("aria-current")),
    ).toHaveLength(1);
  });

  it("marks no view when the URL adds a filter to it", () => {
    navigation.searchParams = new URLSearchParams("status=cancelled&q=berg");
    render(<BookingViews />);

    expect(screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"))).toHaveLength(0);
  });
});

describe("the list's URL model (views.ts)", () => {
  it("[OAD-006 AC1] turns every filter of the URL into the API's parameters", () => {
    const now = Date.parse("2026-10-23T08:00:00Z");
    const href = bookingsHref(new URLSearchParams("limit=10&cursor=c_7"), {
      q: ["anna berg"],
      paymentStatus: ["authorized", "paid"],
      source: ["storefront"],
      customerEmail: ["anna.berg@example.com"],
      travelerLastName: ["Berg"],
      tag: ["vip"],
      departureFrom: ["2026-11-01"],
      departureTo: ["2026-11-30"],
      createdTo: ["2026-10-31"],
      reconcileOutcome: ["manual_review"],
      cancellationRequested: ["false"],
      reference: ["VX3L8R"],
      createdByStaffId: ["stf_01JBT6V2B3K8Q4M9N5P7R1T0VX"],
    });

    const { params, invalid } = listParams(
      new URL(`${href}&cursor=c_7`, "http://admin.invalid").searchParams,
      { now, timeZone: OSLO },
    );

    expect(invalid).toEqual([]);
    expect(params).toEqual({
      limit: 10,
      cursor: "c_7",
      q: "anna berg",
      paymentStatus: ["authorized", "paid"],
      source: ["storefront"],
      reference: "VX3L8R",
      customerEmail: "anna.berg@example.com",
      travelerLastName: "Berg",
      tag: "vip",
      departureFrom: "2026-11-01",
      departureTo: "2026-11-30",
      createdByStaffId: "stf_01JBT6V2B3K8Q4M9N5P7R1T0VX",
      // The end of 31 October in Oslo (CET after the clocks went back on 25 October).
      createdTo: "2026-10-31T23:00:00.000Z",
      reconcileOutcome: ["manual_review"],
      cancellationRequested: false,
    });
  });

  it("counts deadlineWithin from the request and keeps the earlier of two deadlines", () => {
    const now = Date.parse("2026-10-23T08:00:00Z");
    const within24h = paramsOf("/bookings?deadlineWithin=24h", now).params.ticketingDeadlineBefore;
    expect(within24h).toBe(new Date(now + 24 * HOUR).toISOString());

    const earlier = new Date(now + 2 * HOUR).toISOString();
    expect(
      paramsOf(`/bookings?deadlineWithin=7d&ticketingDeadlineBefore=${encodeURIComponent(earlier)}`, now)
        .params.ticketingDeadlineBefore,
    ).toBe(earlier);
  });

  it("[OAD-006 AC2] counts a later page's deadline window from its pinned asOf, never later than now", () => {
    const now = Date.parse("2026-10-23T08:00:00Z");
    const opened = new Date(now - HOUR).toISOString();
    const later = `/bookings?deadlineWithin=24h&asOf=${encodeURIComponent(opened)}&cursor=c_2`;

    // The first page's window, and the same pin for the page after.
    expect(paramsOf(later, now)).toEqual({
      params: { limit: 25, cursor: "c_2", ticketingDeadlineBefore: new Date(now + 23 * HOUR).toISOString() },
      invalid: [],
      pinned: { asOf: opened },
    });
    // A first page (no cursor) counts from the request; so does a pin from the future.
    expect(paramsOf(`/bookings?deadlineWithin=24h&asOf=${encodeURIComponent(opened)}`, now)).toEqual({
      params: { limit: 25, ticketingDeadlineBefore: new Date(now + 24 * HOUR).toISOString() },
      invalid: [],
      pinned: { asOf: new Date(now).toISOString() },
    });
    const future = new Date(now + 48 * HOUR).toISOString();
    expect(
      paramsOf(`/bookings?deadlineWithin=24h&asOf=${encodeURIComponent(future)}&cursor=c_2`, now).params
        .ticketingDeadlineBefore,
    ).toBe(new Date(now + 24 * HOUR).toISOString());
    // A list without a window pins nothing; a pin that is not an instant is named as the page.
    expect(paramsOf("/bookings?status=confirmed&cursor=c_2", now).pinned).toBeUndefined();
    expect(paramsOf("/bookings?deadlineWithin=24h&cursor=c_2&asOf=yesterday", now).invalid).toEqual(["asOf"]);
  });

  it("starts the created days in the OTA's time zone, across a change of daylight saving time", () => {
    expect(dayStartIn("2026-10-01", OSLO)).toBe("2026-09-30T22:00:00.000Z");
    expect(dayStartIn("2026-10-25", OSLO, 1)).toBe("2026-10-25T23:00:00.000Z");
    expect(dayStartIn("2026-10-01", "UTC")).toBe("2026-10-01T00:00:00.000Z");
    expect(dayStartIn("2026-10-01", "Not/AZone")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("names every parameter the API would refuse, and reads repeated and comma-separated lists alike", () => {
    expect(
      paramsOf(
        "/bookings?status=lost&recordLocator=x1&departureFrom=2026-02-30&q=a&q=b&sort=price&limit=500&deadlineWithin=1h",
      ).invalid,
    ).toEqual(["q", "status", "sort", "recordLocator", "departureFrom", "deadlineWithin", "limit"]);

    expect(paramsOf("/bookings?status=confirmed,ticketed&status=confirmed&sort=-created").params).toEqual({
      limit: 25,
      status: ["confirmed", "ticketed"],
    });
    expect(activeView(new URLSearchParams("source=import&q="))?.id).toBe("imported");
    expect(activeView(new URLSearchParams("status=lost"))).toBeUndefined();
  });
});
