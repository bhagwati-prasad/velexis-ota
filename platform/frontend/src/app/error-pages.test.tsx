// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the router of Next.js (the error pages' "Try again" refreshes the segment) -------------------------

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/otas/ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
}));

import SignedInError from "@/app/(app)/error";
import SignedInNotFound, { metadata as signedInNotFoundMetadata } from "@/app/(app)/not-found";
import AuthError from "@/app/(auth)/error";
import MarketingError from "@/app/(marketing)/error";
import RootError from "@/app/error";
import GlobalError from "@/app/global-error";
import RootNotFound, { metadata as rootNotFoundMetadata } from "@/app/not-found";
import { type BoundaryError, ErrorView, referenceOf } from "@/components/error-view";
import { ERROR_PAGE_STRINGS, NOT_FOUND_STRINGS } from "@/lib/strings";

afterEach(() => {
  cleanup();
});

/** What a server error carries in development, and must never reach the page: its message and its stack. */
const SERVER_MESSAGE = "connect ECONNREFUSED 127.0.0.1:3100 (raw detail of the server, never shown)";
const SERVER_STACK = "Error: raw detail\n    at loadTenant (src/lib/tenant.ts:52:7)";

/** A server error as Next.js hands it to a boundary: a digest, here with the message and stack of development. */
function serverError(digest: unknown = "2718281828"): BoundaryError {
  // The digest is any value here, so the tests can hand the page one that is not a digest.
  const error = Object.assign(new Error(SERVER_MESSAGE), { digest }) as unknown as BoundaryError;
  error.stack = SERVER_STACK;
  return error;
}

/** An error thrown in the browser: Next.js gives it no digest. */
function browserError(): BoundaryError {
  const error = new Error(SERVER_MESSAGE);
  error.stack = SERVER_STACK;
  return error;
}

/** The level-1 headings of the document. */
function headings(): HTMLElement[] {
  return screen.queryAllByRole("heading", { level: 1 });
}

/** The element of type `type` somewhere in `node`'s tree of elements (not rendered). */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const found = findElement(child, type);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return undefined;
  }
  if (node.type === type) {
    return node;
  }
  return findElement(node.props["children"] as ReactNode, type);
}

describe("the portal's not-found pages (KI-007)", () => {
  it("[FIX-W69-PAGES AC3] an address that matches no page: its own main, one h1, the home page and My OTAs", () => {
    expect(rootNotFoundMetadata.title).toBe(NOT_FOUND_STRINGS.title);
    render(<RootNotFound />);
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(headings().map((heading) => heading.textContent)).toEqual(["Page not found"]);
    expect(main.textContent).toContain(NOT_FOUND_STRINGS.text);
    const links = within(main).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      [NOT_FOUND_STRINGS.homeLink, "/"],
      [NOT_FOUND_STRINGS.dashboardLink, "/dashboard"],
    ]);
    // Not Next.js's default page.
    expect(document.body.textContent).not.toContain("This page could not be found.");
  });

  it("[FIX-W69-PAGES AC3] notFound() in the signed-in area: no main of its own (the shell has it), one h1 and the way back to My OTAs", () => {
    expect(signedInNotFoundMetadata.title).toBe(NOT_FOUND_STRINGS.title);
    render(<SignedInNotFound />);
    // Its own title, hoisted into the head: caught below the root, the request keeps the page's own metadata.
    expect(document.title).toBe("Page not found · Velexis");
    expect(screen.queryByRole("main")).toBeNull();
    expect(headings().map((heading) => heading.textContent)).toEqual(["Page not found"]);
    expect(document.body.textContent).toContain(NOT_FOUND_STRINGS.signedInText);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Go to My OTAs", "/dashboard"],
    ]);
  });
});

describe("the portal's error pages (KI-007)", () => {
  const areas = [
    {
      name: "the signed-in area",
      Page: SignedInError,
      ownMain: false,
      back: ["Go to My OTAs", "/dashboard"],
    },
    {
      name: "the sign-in and sign-up pages",
      Page: AuthError,
      ownMain: true,
      back: ["Go to sign-in", "/sign-in"],
    },
    { name: "the public pages", Page: MarketingError, ownMain: true, back: ["Go to the home page", "/"] },
    { name: "the root segment", Page: RootError, ownMain: true, back: ["Go to the home page", "/"] },
  ] as const;

  for (const { name, Page, ownMain, back } of areas) {
    it(`[FIX-W69-PAGES AC3] ${name}: one h1, the portal's words and the digest only, "Try again" and the way back`, async () => {
      const reset = vi.fn();
      render(<Page error={serverError()} reset={reset} />);
      expect(headings().map((heading) => heading.textContent)).toEqual([ERROR_PAGE_STRINGS.title]);
      const main = screen.queryByRole("main");
      if (ownMain) {
        expect(main?.id).toBe("main-content");
      } else {
        expect(main).toBeNull();
      }
      const text = document.body.textContent;
      expect(text).toContain(ERROR_PAGE_STRINGS.text);
      expect(text).toContain("Reference for support: 2718281828");
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("raw detail");
      expect(text).not.toContain("tenant.ts");
      const link = screen.getByRole("link");
      expect([link.textContent, link.getAttribute("href")]).toEqual(back);

      // "Try again" asks the server for the segment again and re-renders it.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: ERROR_PAGE_STRINGS.tryAgain }));
        await Promise.resolve();
      });
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect(reset).toHaveBeenCalledTimes(1);
    });
  }

  it("[FIX-W69-PAGES AC3] shows no reference for an error without a digest (a browser error) or with one that is not a digest", () => {
    expect(referenceOf(browserError())).toBeUndefined();
    expect(referenceOf(serverError("<script>alert(1)</script>"))).toBeUndefined();
    expect(referenceOf(serverError("x".repeat(65)))).toBeUndefined();
    expect(referenceOf(serverError(42))).toBeUndefined();
    expect(referenceOf(serverError("NEXT_abc-123"))).toBe("NEXT_abc-123");
    render(<SignedInError error={browserError()} reset={vi.fn()} />);
    expect(document.body.textContent).not.toContain("Reference for support");
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
  });

  it("[FIX-W69-PAGES AC3] the root layout's own error page brings its document, title and main, retries with reset() and loads the home page anew", () => {
    const reset = vi.fn();
    const page = GlobalError({ error: serverError(), reset });
    const markup = renderToStaticMarkup(page);
    expect(markup).toMatch(/^<html lang="en">/);
    expect(markup).toContain(`<title>${ERROR_PAGE_STRINGS.title} · Velexis</title>`);
    expect(markup).toContain('<main id="main-content" tabindex="-1"');
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toContain("Reference for support: 2718281828");
    expect(markup).not.toContain("ECONNREFUSED");
    expect(markup).not.toContain("raw detail");
    // The router is not mounted around it: the button only re-renders, and the link is a plain one.
    const view = findElement(page, ErrorView);
    expect(view?.props["onRetry"]).toBe(reset);
    expect(view?.props["documentLink"]).toBe(true);
    render(<ErrorView {...(view?.props as unknown as Parameters<typeof ErrorView>[0])} />);
    fireEvent.click(screen.getByRole("button", { name: ERROR_PAGE_STRINGS.tryAgain }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: ERROR_PAGE_STRINGS.homeLink }).getAttribute("href")).toBe("/");
  });
});
