// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import ConsoleError from "./error";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("(console) error boundary", () => {
  it("shows the console's message and the request id of an error with the SDK error's shape", () => {
    const error = Object.assign(new Error("The API refused the request (FORBIDDEN)."), {
      code: "FORBIDDEN",
      status: 403,
      requestId: "req_01JBTA",
      details: { requiredPermission: "bookings:issue" },
      fieldErrors: [],
      retryable: false,
    });

    render(<ConsoleError error={error} reset={vi.fn()} />);

    expect(screen.getByRole("heading").textContent).toBe("This page could not be loaded");
    expect(screen.getByText("You do not have permission to do this (bookings:issue).")).toBeTruthy();
    expect(screen.getByText("req_01JBTA")).toBeTruthy();
    expect(screen.queryByText(/The API refused the request/)).toBeNull();
  });

  it("shows the generic message and the digest of a server error that Next.js hid, and tries again", () => {
    const reset = vi.fn();
    const hidden = Object.assign(new Error("An error occurred in the Server Components render."), {
      digest: "2417781945",
    });

    render(<ConsoleError error={hidden} reset={reset} />);

    expect(
      screen.getByText("Something went wrong. Try again, and quote the request id if it persists."),
    ).toBeTruthy();
    expect(screen.getByText("2417781945")).toBeTruthy();
    expect(screen.queryByText(/Server Components render/)).toBeNull();
    expect(screen.getByRole("link", { name: "Go to the dashboard" }).getAttribute("href")).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
