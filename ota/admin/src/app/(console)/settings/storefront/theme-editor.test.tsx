// @vitest-environment happy-dom
// The theme editor of the storefront settings (OAD-014: theme-editor.tsx) in a DOM (README §12): the contrast check of
// lib/contrast.ts and the preview follow what staff type, before anything is saved: a colour pair that fails WCAG AA
// gives the storefront's fallback warning pair by pair, a colour that is not #RRGGBB says so, the colour picker and
// the text edit the same value, and the fonts and the corner radius drive the preview. The form's own action is not
// involved (sections.tsx posts the fields; storefront/actions.test.ts covers the save).
import type { StorefrontSettings } from "@velexis/ota-sdk";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
// The booking page's field components come with that page's server actions, which these tests never call.
vi.mock("@/app/(console)/bookings/[bookingId]/actions", () => ({}));

import { ThemeEditor } from "./theme-editor";

const BRANDING: StorefrontSettings["branding"] = {
  logoAssetId: null,
  logoDarkAssetId: null,
  logoSquareAssetId: null,
  faviconAssetId: null,
  colors: {
    primary: "#0B5FFF",
    secondary: "#0F172A",
    accent: "#B45309",
    background: "#FFFFFF",
    text: "#111827",
  },
  fonts: { heading: "Montserrat", body: "Inter" },
  cornerRadius: "medium",
};

/** The editor as the branding form renders it, with no answer of the action yet. */
function renderEditor(): void {
  render(
    <form>
      <ThemeEditor branding={BRANDING} assets={{}} assetsUnavailable={false} state={{}} />
    </form>,
  );
}

/** The contrast verdict the editor shows: `passes` or `fails`. */
function verdict(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-contrast]");
  if (element === null) {
    throw new Error("no contrast verdict");
  }
  return element;
}

/** The preview's picture of the storefront. */
function preview(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-preview="theme"]');
  if (element === null) {
    throw new Error("no preview");
  }
  return element;
}

// Once per file: the first render of a fresh worker (React, the field components) is the slowest.
beforeAll(() => {
  renderEditor();
  cleanup();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

afterEach(() => {
  cleanup();
});

describe("ThemeEditor", () => {
  it("[OAD-014 AC1] warns while staff type a colour pair that fails WCAG contrast, and stops when it passes again", () => {
    renderEditor();
    expect(verdict().getAttribute("data-contrast")).toBe("passes");

    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "#999999" } });

    expect(verdict().getAttribute("data-contrast")).toBe("fails");
    expect(verdict().textContent).toContain("The storefront will not use these colours");
    expect(verdict().textContent).toContain(
      "The body text on the page background is 2.84:1; it needs 4.5:1.",
    );
    expect(verdict().textContent).toContain("The body text on panels is 2.72:1; it needs 4.5:1.");
    expect(preview().style.color).toBe("#999999");
    // The field posts what was typed: the API decides, the editor only warns.
    expect((screen.getByLabelText("Text") as HTMLInputElement).value).toBe("#999999");

    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "#111827" } });

    expect(verdict().getAttribute("data-contrast")).toBe("passes");
    expect(verdict().textContent).toContain("Every colour pair reaches the WCAG AA contrast of 4.5:1");
  });

  it("names a colour that is not #RRGGBB, and the picker and the text edit the same colour", () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#b4530" } });
    expect(verdict().getAttribute("data-contrast")).toBe("fails");
    expect(verdict().textContent).toContain("Enter every colour as #RRGGBB (accent)");
    // The picker needs a valid colour, so it shows black meanwhile.
    expect((screen.getByLabelText("Accent: colour picker") as HTMLInputElement).value).toBe("#000000");

    fireEvent.change(screen.getByLabelText("Primary: colour picker"), { target: { value: "#38bdf8" } });
    fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#B45309" } });

    expect((screen.getByLabelText("Primary") as HTMLInputElement).value).toBe("#38bdf8");
    expect(verdict().textContent).toContain(
      "The primary colour (links) on the page background is 2.14:1; it needs 4.5:1.",
    );
  });

  it("previews the chosen fonts and corner radius", () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText("Body text"), { target: { value: "Merriweather" } });
    fireEvent.click(screen.getByLabelText("Large"));

    expect(preview().style.fontFamily).toContain("Merriweather");
    expect(preview().style.borderRadius).toBe("1rem");
    expect((screen.getByLabelText("Body text") as HTMLSelectElement).value).toBe("Merriweather");
  });
});
