// @vitest-environment happy-dom
import type { StaffPermission, StaffRole } from "@velexis/ota-sdk";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";
import { staffProfile } from "@/test/fake-ota-api";

import { PermissionGate, missingPermissionText } from "./permission-gate";

/** A Radix tooltip opens on focus; quick alone, slower on a busy CI runner than Testing Library's one second. */
const UI_WAIT = { timeout: 3_000 } as const;

function gate(role: StaffRole, permission: StaffPermission, mode?: "hide") {
  const profile = staffProfile({ role });
  return render(
    <div data-testid="slot">
      {mode === "hide" ? (
        <PermissionGate profile={profile} permission={permission} mode="hide">
          <Button>Refund</Button>
        </PermissionGate>
      ) : (
        <PermissionGate profile={profile} permission={permission} label="Refund">
          <Button>Refund</Button>
        </PermissionGate>
      )}
    </div>,
  );
}

// Once per file: the first Radix tooltip (portal, popper) is the slowest in a fresh worker.
beforeAll(async () => {
  gate("viewer", "payments:refund");
  fireEvent.focus(screen.getByRole("button", { name: "Refund" }).parentElement as HTMLElement);
  await screen.findByRole("tooltip", {}, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("PermissionGate", () => {
  it("renders the content for a role that holds the permission", () => {
    gate("finance", "payments:refund");

    const button = screen.getByRole("button", { name: "Refund" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("disables the action with a tooltip that names the permission when the role lacks it", async () => {
    gate("agent", "payments:refund");

    const button = screen.getByRole("button", { name: "Refund" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Needs the permission payments:refund");

    // The disabled button gets no events: the tooltip sits on its focusable wrapper.
    const wrapper = button.parentElement as HTMLElement;
    expect(wrapper.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(wrapper);
    const tooltip = await screen.findByRole("tooltip", {}, UI_WAIT);
    expect(tooltip.textContent).toBe(missingPermissionText("payments:refund"));
  });

  it("hides the content in hide mode, and for no profile at all", () => {
    gate("viewer", "settings:write", "hide");
    expect(screen.getByTestId("slot").textContent).toBe("");
    cleanup();

    render(
      <PermissionGate profile={null} permission="bookings:read" mode="hide">
        <Button>Bookings</Button>
      </PermissionGate>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("needs both the role matrix and the API's grant", () => {
    // The API granted payments:refund to an agent, which scope §1.3 never does: still disabled.
    const profile = { ...staffProfile({ role: "agent" }), permissions: ["payments:refund" as const] };
    render(
      <PermissionGate profile={profile} permission="payments:refund" label="Refund">
        <Button>Refund</Button>
      </PermissionGate>,
    );
    expect((screen.getByRole("button", { name: "Refund" }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    // The role allows it, but the API's answer left it out: disabled too.
    const narrowed = { ...staffProfile({ role: "owner" }), permissions: ["bookings:read" as const] };
    render(
      <PermissionGate profile={narrowed} permission="settings:write" label="Save">
        <Button>Save</Button>
      </PermissionGate>,
    );
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes the tooltip when the focus leaves", async () => {
    gate("viewer", "bookings:issue");
    const wrapper = screen.getByRole("button", { name: "Refund" }).parentElement as HTMLElement;

    fireEvent.focus(wrapper);
    await screen.findByRole("tooltip", {}, UI_WAIT);
    fireEvent.blur(wrapper);

    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull(), UI_WAIT);
  });
});
