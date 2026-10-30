// @vitest-environment happy-dom
// The dialogs of the assets page (OAD-014: upload-form.tsx) in a DOM, with the server actions mocked (README §12): the
// upload refuses an SVG (by its name, its type or its first bytes) and a file above 1 MB in the browser, in the words
// of the API's `ASSET_INVALID`, without calling the server action, and a file chosen after a refusal replaces it; a
// file it accepts goes to the server action with the rendered idempotency key, the kind and the file; the delete
// dialog asks no reason and posts the image's id.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ uploadAsset: vi.fn(), deleteAsset: vi.fn() }));
vi.mock("./actions", () => actions);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
// The environment badge's module imports the switch's server actions; the dialogs never call them.
vi.mock("@/app/(console)/env-actions", () => ({ switchEnvironment: vi.fn(), resetEnvironment: vi.fn() }));
// The booking page's field components come with that page's server actions, which these tests never call.
vi.mock("@/app/(console)/bookings/[bookingId]/actions", () => ({}));

import type { ActionState } from "@/lib/action-state";

import { MAX_ASSET_BYTES } from "./asset-rules";
import { DeleteAssetDialog, UploadAssetDialog } from "./upload-form";

/** The key the page rendered (a dummy UUID). */
const KEY = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
const LOGO_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M1N";

/** How long a step that runs a (fake) server action through React's action queue or opens a dialog may take. */
const UI_WAIT = { timeout: 3_000 } as const;

const TYPE_MESSAGE =
  "Upload a PNG, JPEG or WebP image (an ICO file for a favicon). SVG files are not accepted.";
const SIZE_MESSAGE = "The image is larger than 1 MB. Make it smaller and upload it again.";

/** The first bytes of a PNG file. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

/** What a mocked action received: the fields of each submission. */
function submissions(action: ReturnType<typeof vi.fn>): FormData[] {
  return action.mock.calls.map((call) => call[1] as FormData);
}

/** Opens the upload dialog and answers it. */
async function openUpload(): Promise<HTMLElement> {
  render(<UploadAssetDialog environment="test" idempotencyKey={KEY} defaultKind="favicon" />);
  fireEvent.click(screen.getByRole("button", { name: "Upload an image" }));
  return screen.findByRole("dialog", {}, UI_WAIT);
}

/**
 * Chooses `file` in the dialog's file input, as a browser does: through the input's own `files` (happy-dom's
 * `FormData` reads them there; Testing Library's `target: { files }` would only shadow the property), then `change`.
 */
function choose(dialog: HTMLElement, file: File): HTMLInputElement {
  const input = within(dialog).getByLabelText("Image file") as HTMLInputElement;
  const FileListOf = (input.files as FileList).constructor as new () => FileList & File[];
  const files = new FileListOf();
  files.push(file);
  input.files = files;
  fireEvent.change(input);
  return input;
}

/** The file field's error, linked to the input. */
function fileError(input: HTMLInputElement): string | undefined {
  const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
  return ids
    .map((id) => document.getElementById(id))
    .find((element) => element?.id.endsWith("-error"))
    ?.textContent?.trim();
}

// Once per file: the first render of a Radix dialog in a fresh worker is the slowest.
beforeAll(async () => {
  await openUpload();
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  actions.uploadAsset.mockReset();
  actions.deleteAsset.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("UploadAssetDialog", () => {
  it("[OAD-014 AC2] refuses an SVG in the browser, by its name or its first bytes, without calling the server action", async () => {
    const dialog = await openUpload();

    // By its name, as soon as it is chosen.
    const input = choose(dialog, new File([SVG_TEXT], "logo.svg", { type: "image/svg+xml" }));
    expect(fileError(input)).toBe(TYPE_MESSAGE);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    // Renamed and typed as a PNG: its first bytes, read when the dialog posts it.
    choose(dialog, new File([SVG_TEXT], "logo.png", { type: "image/png" }));
    expect(fileError(input)).toBeUndefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    const alert = await within(dialog).findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain(TYPE_MESSAGE);
    expect(fileError(input)).toBe(TYPE_MESSAGE);
    expect(actions.uploadAsset).not.toHaveBeenCalled();
  });

  it("refuses a file above 1 MB when it is chosen, and sends the next file it accepts with the rendered key", async () => {
    actions.uploadAsset.mockResolvedValue({ ok: false, message: "Try again." } satisfies ActionState);
    const dialog = await openUpload();

    const input = choose(
      dialog,
      new File([new Uint8Array(MAX_ASSET_BYTES + 1)], "photo.png", { type: "image/png" }),
    );
    expect(fileError(input)).toBe(SIZE_MESSAGE);

    choose(dialog, new File([PNG_BYTES], "favicon.png", { type: "image/png" }));
    expect(fileError(input)).toBeUndefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(actions.uploadAsset).toHaveBeenCalledTimes(1), UI_WAIT);
    const [posted] = submissions(actions.uploadAsset);
    expect(posted?.get("actionKey")).toBe(KEY);
    expect(posted?.get("kind")).toBe("favicon");
    expect(posted?.has("reason")).toBe(false);
    const sent = posted?.get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("favicon.png");
  });

  it("shows the server action's refusal on the file, until another file is chosen", async () => {
    const message =
      "This file is already your logo (ast_01JA6B2C3D4E5F6G7H8J9K0M1N). One file can be one kind of image only: delete that image first, or upload a different file.";
    actions.uploadAsset.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      message,
      requestId: "req_1",
      fieldErrors: { file: message },
    } satisfies ActionState);
    const dialog = await openUpload();

    const input = choose(dialog, new File([PNG_BYTES], "favicon.png", { type: "image/png" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    const alert = await within(dialog).findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("Request id req_1");
    expect(fileError(input)).toBe(message);

    choose(dialog, new File([PNG_BYTES], "other.png", { type: "image/png" }));
    expect(fileError(input)).toBeUndefined();
  });
});

describe("DeleteAssetDialog", () => {
  it("asks no reason and posts the image's id", async () => {
    actions.deleteAsset.mockResolvedValue({ ok: false, message: "Try again." } satisfies ActionState);
    render(
      <DeleteAssetDialog
        assetId={LOGO_ID}
        fileName="demo-logo.png"
        environment="test"
        idempotencyKey={KEY}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete demo-logo.png" }));
    const dialog = await screen.findByRole("dialog", {}, UI_WAIT);
    expect(within(dialog).queryByLabelText("Reason")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete image" }));

    await waitFor(() => expect(actions.deleteAsset).toHaveBeenCalledTimes(1), UI_WAIT);
    const [posted] = submissions(actions.deleteAsset);
    expect(posted?.get("assetId")).toBe(LOGO_ID);
    expect(posted?.has("reason")).toBe(false);
  });
});
