// @vitest-environment happy-dom
// The content pages' and e-mail templates' client side (OAD-015: pages/page-form.tsx, templates/template-form.tsx,
// templates/preview-frame.tsx) in a DOM, with the server actions mocked (README §12): the preview's frame is sandboxed
// without `allow-scripts` (and without `allow-same-origin`) and holds the rendered HTML only in its `srcdoc`; a body the
// API refused is shown next to the line it names, in the lines around it as they were sent, with "Go to line N"; a
// refused template is listed per part and line; the forms and dialogs post their hidden fields and keys.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pageActions = vi.hoisted(() => ({ createPage: vi.fn(), updatePage: vi.fn(), deletePage: vi.fn() }));
const templateActions = vi.hoisted(() => ({
  saveTemplate: vi.fn(),
  previewTemplate: vi.fn(),
  resetTemplate: vi.fn(),
}));
vi.mock("./pages/actions", () => pageActions);
vi.mock("./templates/actions", () => templateActions);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
// The environment badge's module imports the switch's server actions; the dialogs never call them.
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));
// The booking page's field components come with that page's server actions, which these tests never call.
vi.mock("@/app/(console)/bookings/[bookingId]/actions", () => ({}));

import type { ActionState } from "@/lib/action-state";

import type { PageActionState, PreviewActionState, TemplateActionState } from "./content-rules";
import { DeletePageDialog, PageForm } from "./pages/page-form";
import { PREVIEW_SANDBOX, PreviewFrame } from "./templates/preview-frame";
import { ResetTemplateDialog, TemplateEditor } from "./templates/template-form";

/** The key the page rendered (a dummy UUID) and the one a refusal brings. */
const KEY = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
const NEXT_KEY = "7f1d2c3b-4a59-4e6f-9a8b-1c2d3e4f5a60";
const PAGE_ID = "stp_01JA7Q1S3U5W7Y9A1C3E5G7J9L";
const ADDRESS = { templateKey: "booking.confirmed", channel: "email", locale: "en" } as const;

/** How long a step that runs a (fake) server action through React's action queue or opens a dialog may take. */
const UI_WAIT = { timeout: 3_000 } as const;

const LINE_3_MESSAGE =
  "Line 3 uses Markdown that content pages do not allow. Change it to the subset the help above the body lists.";

/** What a mocked action received: the fields of each submission. */
function submissions(action: ReturnType<typeof vi.fn>): FormData[] {
  return action.mock.calls.map((call) => call[1] as FormData);
}

/** The element a control's `aria-describedby` names last (its error, when it has one). */
function describedErrorOf(control: HTMLElement): HTMLElement | null {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter((id) => id !== "");
  const errorId = ids.find((id) => id.endsWith("-error"));
  return errorId === undefined ? null : document.getElementById(errorId);
}

function renderEditForm() {
  return render(
    <PageForm
      mode="edit"
      pageId={PAGE_ID}
      version={3}
      values={{
        kind: "faq",
        title: "Baggage FAQ",
        bodyMarkdown: "## Bags",
        isPublished: true,
        showInFooter: false,
        sortOrder: 20,
      }}
    />,
  );
}

function renderEditor(overrides: Partial<Parameters<typeof TemplateEditor>[0]> = {}) {
  return render(
    <TemplateEditor
      address={ADDRESS}
      version={4}
      values={{
        subject: "Your trip {{booking.reference}}",
        bodyHtml: "<p>Hello</p>\n<p>{{booking.pnr}}</p>",
        bodyText: "Hello",
        isActive: true,
      }}
      canWrite
      formKey="4"
      {...overrides}
    />,
  );
}

// Once per file: the first render of the forms and of a Radix dialog in a fresh worker is the slowest.
beforeAll(async () => {
  // happy-dom runs the scripts of a frame's `srcdoc` whatever its `sandbox` says (a browser runs none without
  // `allow-scripts`): the test document runs no markup script at all, so a template's script cannot act here either.
  (
    window as unknown as { happyDOM: { settings: { disableJavaScriptEvaluation: boolean } } }
  ).happyDOM.settings.disableJavaScriptEvaluation = true;
  renderEditForm();
  renderEditor();
  render(
    <DeletePageDialog
      pageId={PAGE_ID}
      title="Baggage FAQ"
      slug="baggage-faq"
      locale="en"
      version={3}
      environment="test"
      idempotencyKey={KEY}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete page" }));
  await screen.findByRole("dialog", {}, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  for (const action of [...Object.values(pageActions), ...Object.values(templateActions)]) {
    action.mockReset();
  }
});

afterEach(() => {
  cleanup();
});

describe("PreviewFrame", () => {
  it("[OAD-015 AC1] puts the rendered HTML in a frame sandboxed without allow-scripts or allow-same-origin", () => {
    const html = "<p>Hello Anna,</p><script>parent.document.title = 'owned'</script>";
    const { container } = render(<PreviewFrame html={html} />);

    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.hasAttribute("sandbox")).toBe(true);
    const tokens = (frame?.getAttribute("sandbox") ?? "").split(/\s+/).filter((token) => token !== "");
    expect(tokens).not.toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).toEqual([]);
    expect(PREVIEW_SANDBOX).toBe("");
    expect(frame?.getAttribute("srcdoc")).toBe(html);
    expect(frame?.getAttribute("title")).toBe("Preview of the HTML body of the e-mail");
    // The template's markup never enters the admin's own document.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
  });
});

describe("TemplateEditor", () => {
  it("[OAD-015 AC1] previews the draft in the sandboxed frame, for a role that only reads too", async () => {
    templateActions.previewTemplate.mockResolvedValue({
      ok: true,
      message: "Preview rendered below with the template's sample data. Nothing was saved or sent.",
      preview: {
        subject: "Your trip VX7K2Q",
        html: "<p>Hello Anna</p><script>alert(1)</script>",
        text: "Hello Anna",
      },
    } satisfies PreviewActionState);
    renderEditor({ canWrite: false, version: null, formKey: "none" });

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect((screen.getByLabelText("HTML body") as HTMLTextAreaElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    const frame = await screen.findByTitle("Preview of the HTML body of the e-mail", {}, UI_WAIT);
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBe("<p>Hello Anna</p><script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("Your trip VX7K2Q")).toBeTruthy();
    const [posted] = submissions(templateActions.previewTemplate);
    expect(posted?.get("templateKey")).toBe("booking.confirmed");
    expect(posted?.get("channel")).toBe("email");
    expect(posted?.get("locale")).toBe("en");
    expect(posted?.get("version")).toBe("");
    expect(posted?.get("bodyHtml")).toBe("<p>Hello</p>\n<p>{{booking.pnr}}</p>");
  });

  it("lists a refused template per part and line, and goes to the line in its part", async () => {
    templateActions.saveTemplate.mockResolvedValue({
      ok: false,
      code: "TEMPLATE_INVALID",
      message: "The template does not compile. Check the highlighted parts.",
      requestId: "req_1",
      problems: [
        { part: "bodyHtml", line: 2, message: "booking.pnr is not a variable of booking.confirmed." },
        { part: "subject", line: 1, message: "Expecting 'ID'." },
      ],
      fieldErrors: {
        bodyHtml: "Line 2: booking.pnr is not a variable of booking.confirmed.",
        subject: "Line 1: Expecting 'ID'.",
      },
    } satisfies TemplateActionState);
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const list = await screen.findByRole("region", { name: "The template does not compile" }, UI_WAIT);
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-part"))).toEqual(["bodyHtml", "subject"]);
    expect(items[0]?.textContent).toContain(
      "HTML body, line 2: booking.pnr is not a variable of booking.confirmed.",
    );
    expect(items[1]?.textContent).toContain("Subject, line 1: Expecting 'ID'.");
    const html = screen.getByLabelText("HTML body") as HTMLTextAreaElement;
    expect(describedErrorOf(html)?.textContent).toBe(
      "Line 2: booking.pnr is not a variable of booking.confirmed.",
    );
    expect(html.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("Request id req_1");

    fireEvent.click(within(list).getByRole("button", { name: "Go to line 2 of the HTML body" }));
    expect(document.activeElement).toBe(html);
    expect(html.value.slice(html.selectionStart, html.selectionEnd)).toBe("<p>{{booking.pnr}}</p>");
    const [posted] = submissions(templateActions.saveTemplate);
    expect(posted?.get("version")).toBe("4");
    expect(posted?.get("isActive")).toBe("true");
  });
});

describe("PageForm", () => {
  it("[OAD-015 AC2] shows a refused body's message next to the line it names, and goes to that line", async () => {
    pageActions.updatePage.mockResolvedValue({
      ok: false,
      code: "UNPROCESSABLE",
      message: LINE_3_MESSAGE,
      requestId: "req_2",
      fieldErrors: { bodyMarkdown: LINE_3_MESSAGE },
      bodyLine: 3,
    } satisfies PageActionState);
    renderEditForm();
    const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
    fireEvent.change(body, {
      target: { value: "## Bags\n\n<table><tr><td>1</td></tr></table>\n\nIt depends on your fare." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const excerpt = await screen.findByRole(
      "list",
      { name: "The body around line 3, as it was sent" },
      UI_WAIT,
    );
    const rows = within(excerpt).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-line"))).toEqual(["1", "2", "3", "4", "5"]);
    const reported = excerpt.querySelector('[data-line="3"]') as HTMLElement;
    expect(reported.getAttribute("aria-current")).toBe("true");
    expect(reported.textContent).toContain("<table><tr><td>1</td></tr></table>");
    expect(reported.textContent).toContain(LINE_3_MESSAGE);
    // Only the reported line carries the message, and the body's text area is described by it.
    expect(excerpt.querySelector('[data-line="2"]')?.textContent).not.toContain(LINE_3_MESSAGE);
    expect(body.getAttribute("aria-invalid")).toBe("true");
    expect(reported.contains(describedErrorOf(body))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Go to line 3" }));
    expect(document.activeElement).toBe(body);
    expect(body.value.slice(body.selectionStart, body.selectionEnd)).toBe(
      "<table><tr><td>1</td></tr></table>",
    );

    const [posted] = submissions(pageActions.updatePage);
    expect(posted?.get("pageId")).toBe(PAGE_ID);
    expect(posted?.get("version")).toBe("3");
    expect(posted?.get("isPublished")).toBe("true");
    expect(posted?.has("showInFooter")).toBe(false);
    expect(posted?.has("actionKey")).toBe(false);
  });

  it("sends a new page with the rendered key, and the key a refusal brings after it", async () => {
    pageActions.createPage.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      message: "A page with the address /p/terms already exists in en.",
      fieldErrors: { slug: "A page with the address /p/terms already exists in en." },
      nextActionKey: NEXT_KEY,
    } satisfies ActionState);
    render(<PageForm mode="create" idempotencyKey={KEY} locales={["en", "fr"]} defaultLocale="fr" />);
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "terms" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Terms" } });

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(pageActions.createPage).toHaveBeenCalledTimes(1), UI_WAIT);
    const address = screen.getByLabelText("Address");
    await waitFor(() => expect(address.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    expect(describedErrorOf(address)?.textContent).toBe(
      "A page with the address /p/terms already exists in en.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(pageActions.createPage).toHaveBeenCalledTimes(2), UI_WAIT);
    const [first, second] = submissions(pageActions.createPage);
    expect(first?.get("actionKey")).toBe(KEY);
    expect(first?.get("slug")).toBe("terms");
    expect(first?.get("locale")).toBe("fr");
    expect(first?.get("kind")).toBe("content");
    expect(first?.get("sortOrder")).toBe("100");
    expect(second?.get("actionKey")).toBe(NEXT_KEY);
  });
});

describe("DeletePageDialog and ResetTemplateDialog", () => {
  it("asks no reason and posts the page and its displayed version", async () => {
    pageActions.deletePage.mockResolvedValue({ ok: false, message: "Try again." } satisfies ActionState);
    render(
      <DeletePageDialog
        pageId={PAGE_ID}
        title="Baggage FAQ"
        slug="baggage-faq"
        locale="en"
        version={3}
        environment="live"
        idempotencyKey={KEY}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete page" }));
    const dialog = await screen.findByRole("dialog", {}, UI_WAIT);
    expect(dialog.textContent).toContain("/p/baggage-faq (en)");
    expect(within(dialog).queryByLabelText("Reason")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete page in LIVE" }));

    await waitFor(() => expect(pageActions.deletePage).toHaveBeenCalledTimes(1), UI_WAIT);
    const [posted] = submissions(pageActions.deletePage);
    expect(posted?.get("pageId")).toBe(PAGE_ID);
    expect(posted?.get("version")).toBe("3");
    expect(posted?.has("reason")).toBe(false);
  });

  it("posts the template's address, and is disabled without a row of the locale's own", async () => {
    templateActions.resetTemplate.mockResolvedValue({
      ok: false,
      message: "Try again.",
    } satisfies ActionState);
    render(<ResetTemplateDialog address={ADDRESS} hasOwnRow environment="test" idempotencyKey={KEY} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    const dialog = await screen.findByRole("dialog", {}, UI_WAIT);
    expect(within(dialog).queryByLabelText("Reason")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(templateActions.resetTemplate).toHaveBeenCalledTimes(1), UI_WAIT);
    const [posted] = submissions(templateActions.resetTemplate);
    expect(posted?.get("templateKey")).toBe("booking.confirmed");
    expect(posted?.get("channel")).toBe("email");
    expect(posted?.get("locale")).toBe("en");

    cleanup();
    render(
      <ResetTemplateDialog address={ADDRESS} hasOwnRow={false} environment="test" idempotencyKey={KEY} />,
    );
    expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/has no template of its own/)).toBeTruthy();
  });
});
