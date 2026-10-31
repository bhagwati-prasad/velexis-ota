// @vitest-environment happy-dom
import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the navigation of Next.js and the environment switch's server actions -----------------------------

const navigation = vi.hoisted(() => ({ pathname: "/bookings", searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const envActions = vi.hoisted(() => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));
vi.mock("@/app/(console)/env-actions", () => envActions);

import { staffProfile } from "@/test/fake-ota-api";

import { NAV_SECTIONS, consoleNavigation, currentNavEntry } from "./console-nav";
import { DataTable, formatTotalCount, listHref } from "./data-table";
import { ENVIRONMENT_STRINGS, EnvironmentBanner, EnvironmentSwitch } from "./env-banner";
import { ErrorState } from "./error-state";
import { JsonView, formatJson } from "./json-view";
import { Money, formatMoney } from "./money";
import { STATUS_LABELS, StatusBadge, describeStatus } from "./status-badge";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

/** A server action through React's action queue: quick alone, slower on a busy CI runner than one second. */
const UI_WAIT = { timeout: 3_000 } as const;

// Once per file: React's first action and the first renders are the slowest in a fresh worker; on a busy CI runner
// they would otherwise land in the first test's own five seconds. Nothing of it stays.
beforeAll(async () => {
  envActions.switchEnvironment.mockResolvedValue({ ok: false, message: "warm-up" });
  render(<EnvironmentSwitch environment="test" />);
  fireEvent.click(screen.getByRole("button", { name: ENVIRONMENT_STRINGS.live }));
  await screen.findByRole("alert", {}, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  navigation.pathname = "/bookings";
  navigation.searchParams = new URLSearchParams();
  envActions.switchEnvironment.mockReset();
  envActions.resetEnvironment.mockReset();
  envActions.resetEnvironment.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("StatusBadge", () => {
  it("says every status in words, with a tone, and never relies on colour alone", () => {
    render(
      <>
        <StatusBadge kind="booking" status="partially_ticketed" />
        <StatusBadge kind="ticketing" status="manual_review" />
        <StatusBadge kind="payment" status="authorized" />
        <StatusBadge kind="paymentRecord" status="captured" />
        <StatusBadge kind="sync" status="order_not_found" />
      </>,
    );

    for (const [label, tone] of [
      ["Partially ticketed", "warning"],
      ["Manual review", "warning"],
      ["Authorised", "info"],
      ["Captured", "success"],
      ["Order not found", "danger"],
    ]) {
      expect(screen.getByText(label as string).getAttribute("data-tone"), label).toBe(tone);
    }
  });

  it("has a label for every status of the document, and shows an unknown one in its raw form", () => {
    for (const labels of Object.values(STATUS_LABELS)) {
      for (const label of Object.values(labels)) {
        expect(label.length).toBeGreaterThan(0);
      }
    }
    expect(describeStatus("booking", "on_hold")).toEqual({ label: "on hold", tone: "neutral" });
    expect(describeStatus("sync", "toString")).toEqual({ label: "toString", tone: "neutral" });
  });
});

describe("Money", () => {
  it("formats the decimal string exactly, with the currency's digits and every digit of the amount", () => {
    expect(formatMoney({ amount: "412.5", currency: "EUR" })).toBe("€412.50");
    expect(formatMoney({ amount: "120.4567", currency: "EUR" })).toBe("€120.4567");
    expect(formatMoney({ amount: "12345678901234567.89", currency: "USD" })).toBe(
      "$12,345,678,901,234,567.89",
    );
    expect(formatMoney({ amount: "1500", currency: "JPY" })).toBe("¥1,500");
    expect(formatMoney({ amount: "-25.00", currency: "EUR" })).toBe("-€25.00");
    expect(formatMoney({ amount: "1e3", currency: "EUR" })).toBeUndefined();
    expect(formatMoney({ amount: "10", currency: "eur" })).toBeUndefined();
  });

  it("keeps the machine-readable amount and shows an unreadable one as it came", () => {
    render(
      <>
        <Money value={{ amount: "99.90", currency: "EUR" }} />
        <Money value={{ amount: "n/a", currency: "EUR" }} />
      </>,
    );

    expect(screen.getByText("€99.90").getAttribute("value")).toBe("99.90");
    expect(screen.getByText("n/a EUR")).toBeTruthy();
  });
});

describe("JsonView", () => {
  it("is collapsed by default and shows the payload as escaped, indented JSON", () => {
    render(
      <JsonView
        value={{ note: '<img src="x" onerror="alert(1)">', data: { id: "1" } }}
        label="Amadeus order"
      />,
    );

    const details = screen.getByText("Amadeus order").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const region = within(details).getByRole("region", { hidden: true, name: "Amadeus order" });
    expect(region.textContent).toBe(
      formatJson({ note: '<img src="x" onerror="alert(1)">', data: { id: "1" } }),
    );
    expect(region.querySelector("img")).toBeNull();
  });

  it("opens on request and says so when there is nothing to show or it is not JSON", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    render(
      <>
        <JsonView value={{ a: 1 }} label="Open" open />
        <JsonView value={null} label="Empty" />
        <JsonView value={cycle} label="Cycle" />
      </>,
    );

    expect((screen.getByText("Open").closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(
      within(screen.getByText("Empty").closest("details") as HTMLElement).getByText("Nothing to show."),
    ).toBeTruthy();
    expect(
      within(screen.getByText("Cycle").closest("details") as HTMLElement).getByText(
        "This value cannot be shown as JSON.",
      ),
    ).toBeTruthy();
  });
});

interface Row {
  readonly id: string;
  readonly reference: string;
}

const COLUMNS: ColumnDef<Row, string>[] = [
  { accessorKey: "reference", header: "Reference", cell: (cell) => cell.getValue() },
];

describe("DataTable", () => {
  it("renders the rows the server fetched and links the next page with the filters kept", () => {
    navigation.searchParams = new URLSearchParams("status=confirmed&status=ticketed&sort=-created");
    render(
      <DataTable
        caption="Bookings"
        columns={COLUMNS}
        data={[
          { id: "bkg_1", reference: "VX-7K2M9Q" },
          { id: "bkg_2", reference: "VX-8L3N0R" },
        ]}
        getRowId={(row) => row.id}
        page={{ nextCursor: "c_2" }}
        totalCount={42}
      />,
    );

    const table = screen.getByRole("table", { name: "Bookings" });
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual(["Reference", "VX-7K2M9Q", "VX-8L3N0R"]);
    expect(screen.getByText("42 in total")).toBeTruthy();
    const pages = screen.getByRole("navigation", { name: "Pages" });
    expect(within(pages).queryByRole("link", { name: "First page" })).toBeNull();
    expect(within(pages).getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/bookings?status=confirmed&status=ticketed&sort=-created&cursor=c_2",
    );
  });

  it("links back to the first page on a later page, and shows the empty message", () => {
    navigation.searchParams = new URLSearchParams("q=nordmann&cursor=c_2");
    render(
      <DataTable
        caption="Bookings"
        columns={COLUMNS}
        data={[]}
        page={{ nextCursor: null }}
        emptyMessage="No booking needs attention."
        totalCount={null}
      />,
    );

    expect(screen.getByText("No booking needs attention.")).toBeTruthy();
    expect(screen.getByText("10,000+ in total")).toBeTruthy();
    expect(screen.getByRole("link", { name: "First page" }).getAttribute("href")).toBe(
      "/bookings?q=nordmann",
    );
    expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
  });

  it("[FIX-W31-PLATFORM AC4] scrolls a wide table in a container that takes the keyboard focus and shows it", () => {
    render(<DataTable caption="Bookings" columns={COLUMNS} data={[]} page={{ nextCursor: null }} />);

    // axe `scrollable-region-focusable` (WCAG 2.1.1): the arrow keys scroll what the keyboard can focus, as the
    // portal's table does since PFE-015.
    const container = screen.getByRole("table", { name: "Bookings" }).parentElement as HTMLElement;
    expect(container.dataset["slot"]).toBe("table-container");
    expect(container.getAttribute("tabindex")).toBe("0");
    expect(container.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["overflow-x-auto", "focus-visible:ring-[3px]", "focus-visible:ring-ring/50"]),
    );
    container.focus();
    expect(document.activeElement).toBe(container);
  });

  it("builds list URLs that keep repeated parameters and drop emptied ones", () => {
    const current = new URLSearchParams("status=confirmed&status=ticketed&q=x&cursor=c_9");
    expect(listHref("/bookings", current, { q: null, cursor: null })).toBe(
      "/bookings?status=confirmed&status=ticketed",
    );
    expect(listHref("/bookings", new URLSearchParams(), {})).toBe("/bookings");
    expect(listHref("/bookings", current, { q: "kari" })).toBe(
      "/bookings?status=confirmed&status=ticketed&cursor=c_9&q=kari",
    );
    expect(formatTotalCount(undefined)).toBeUndefined();
    expect(formatTotalCount(0)).toBe("0");
    expect(formatTotalCount(9_999)).toBe("9,999");
  });
});

describe("ConsoleNav model", () => {
  it("shows each role the areas of scope §1.3 and drops empty groups", () => {
    const labels = (role: "owner" | "agent" | "finance" | "viewer") =>
      consoleNavigation(staffProfile({ role })).flatMap((section) =>
        section.entries.map((entry) => entry.id),
      );

    const everything = NAV_SECTIONS.flatMap((section) => section.entries.map((entry) => entry.id));
    expect(labels("owner")).toEqual(everything);
    expect(labels("agent")).toEqual(everything);
    expect(labels("finance")).toEqual(everything.filter((id) => !["queues", "shopping"].includes(id)));
    expect(labels("viewer")).toEqual(
      everything.filter((id) => !["queues", "shopping", "supplier-log"].includes(id)),
    );
    // Without a profile only the links that need no permission are left.
    expect(consoleNavigation(null)).toEqual([
      expect.objectContaining({ id: "support", entries: [expect.objectContaining({ id: "portal" })] }),
    ]);
  });

  it("marks the most specific entry of the current path", () => {
    const sections = consoleNavigation(staffProfile({ role: "owner" }));
    expect(currentNavEntry(sections, "/")?.id).toBe("dashboard");
    expect(currentNavEntry(sections, "/bookings/bkg_1")?.id).toBe("bookings");
    expect(currentNavEntry(sections, "/settings/fees/new")?.id).toBe("fees");
    expect(currentNavEntry(sections, "/bookingsx")).toBeUndefined();
  });
});

describe("ErrorState", () => {
  it("shows the console's message and the request id, never the API's message", () => {
    render(
      <ErrorState
        title="Bookings could not be loaded"
        error={{
          code: "RATE_LIMITED",
          status: 429,
          message: "slow down",
          requestId: "req_9",
          fieldErrors: [],
          retryable: true,
          retryAfterSeconds: 12,
        }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 2 }).textContent).toBe("Bookings could not be loaded");
    expect(alert.textContent).toContain("Too many requests, retry in 12 s.");
    expect(alert.textContent).toContain("Request id: req_9");
    expect(alert.textContent).not.toContain("slow down");
  });
});

describe("EnvironmentSwitch", () => {
  it("posts the chosen environment to the server action and shows a refusal", async () => {
    envActions.switchEnvironment.mockResolvedValue({
      ok: false,
      code: "ENVIRONMENT_NOT_ALLOWED",
      message: ENVIRONMENT_STRINGS.liveRefused,
    });
    render(<EnvironmentSwitch environment="test" />);
    const group = screen.getByRole("group", { name: ENVIRONMENT_STRINGS.label });
    expect((within(group).getByRole("button", { name: "TEST" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(group).getByRole("button", { name: "LIVE" }));

    expect((await screen.findByRole("alert", {}, UI_WAIT)).textContent).toBe(ENVIRONMENT_STRINGS.liveRefused);
    expect(envActions.switchEnvironment).toHaveBeenCalledTimes(1);
    const [, formData] = envActions.switchEnvironment.mock.calls[0] as [unknown, FormData];
    expect(formData.get("environment")).toBe("live");
  });
});

describe("EnvironmentBanner", () => {
  it("warns in live mode and shows nothing in test mode", () => {
    const { rerender } = render(<EnvironmentBanner environment="live" liveRefused={false} />);
    expect(screen.getByRole("note").textContent).toBe(ENVIRONMENT_STRINGS.liveWarning);

    rerender(<EnvironmentBanner environment="test" liveRefused={false} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(envActions.resetEnvironment).not.toHaveBeenCalled();
  });

  it("shows the refusal of live, resets the cookie once and keeps the notice until it is dismissed", async () => {
    const { rerender } = render(<EnvironmentBanner environment="test" liveRefused />);

    expect(screen.getByRole("status").textContent).toContain(ENVIRONMENT_STRINGS.liveRefused);
    await waitFor(() => expect(envActions.resetEnvironment).toHaveBeenCalledTimes(1), UI_WAIT);

    // The reset re-renders the page with the cookie at test: no refusal any more, the notice stays.
    rerender(<EnvironmentBanner environment="test" liveRefused={false} />);
    expect(screen.getByRole("status").textContent).toContain(ENVIRONMENT_STRINGS.liveRefused);
    expect(envActions.resetEnvironment).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: ENVIRONMENT_STRINGS.dismiss }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("DropdownMenuItem", () => {
  it("[FIX-W32-PLATFORM AC3] labels a focused destructive item in the foreground colour on its tint, never the destructive one", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Booking actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Add a note</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Cancel the booking</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: "Cancel the booking" });
    expect(item.dataset["variant"]).toBe("destructive");
    const classes = item.className.split(/\s+/);
    // text-destructive on bg-destructive/10 over the popover is 4.0:1, under the 4.5:1 of WCAG 1.4.3; text-foreground
    // there is 16.63:1. The look stays: the red label at rest (4.76:1), the tint and the red icon on focus.
    expect(classes).toEqual(
      expect.arrayContaining([
        "data-[variant=destructive]:text-destructive",
        "data-[variant=destructive]:focus:bg-destructive/10",
        "data-[variant=destructive]:*:[svg]:!text-destructive",
        "data-[variant=destructive]:focus:text-foreground",
      ]),
    );
    expect(classes.filter((name) => /(^|:)focus:text-destructive/.test(name))).toEqual([]);
  });
});

describe("destructive Button and Badge", () => {
  it("darken on hover instead of fading, so their white text keeps 4.5:1", () => {
    render(
      <>
        <Button variant="destructive">Reset two-factor</Button>
        <Badge variant="destructive">Failed</Badge>
      </>,
    );

    // bg-destructive/90 over a white page is #ea1a23: 4.49:1 for white text, under the 4.5:1 of WCAG 1.4.3 (axe found
    // it on a hovered button in e2e run 40938272523). Mixing in 10% black is #c90008: 6.03:1; at rest 4.76:1.
    const hover = "hover:bg-[color-mix(in_oklch,var(--destructive),black_10%)]";
    const button = screen.getByRole("button", { name: "Reset two-factor" }).className.split(/\s+/);
    const badge = screen.getByText("Failed").className.split(/\s+/);
    expect(button).toContain(hover);
    expect(badge).toContain(`[a&]:${hover}`);
    expect([...button, ...badge].filter((name) => /hover:bg-destructive\/\d+$/.test(name))).toEqual([]);
  });
});

describe("Tabs", () => {
  it("[FIX-W32-PLATFORM AC3] sets the tab list's text in the foreground colour on the muted background, never the muted one", () => {
    render(
      <Tabs defaultValue="summary">
        <TabsList aria-label="Booking sections">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">The booking&apos;s summary.</TabsContent>
      </Tabs>,
    );

    // text-muted-foreground on bg-muted is 4.34:1, under the 4.5:1 of WCAG 1.4.3; text-foreground there is 18.15:1.
    const list = screen.getByRole("tablist", { name: "Booking sections" });
    const classes = list.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["bg-muted", "text-foreground"]));
    expect(classes.filter((name) => /(^|:)text-muted-foreground$/.test(name))).toEqual([]);
    // The triggers keep the colour they had, so the tabs look as before.
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className.split(/\s+/)).toContain("text-foreground");
    }
  });
});
