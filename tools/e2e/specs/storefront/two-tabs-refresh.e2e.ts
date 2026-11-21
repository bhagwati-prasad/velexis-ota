// Two tabs of one browser refresh the storefront's cookie session (FIX-W67-KI003, guidebook known issue KI-003, lead
// decision (36f) of 2026-11-21; OADR-0006 point 5 and its note of 2026-11-21, ota/sdk/README.md §4.1), in the
// `storefront` project: the production build in `vite preview` for the demo OTA, proxied to the OTA API.
//
//   a customer signs up (the session opens at once) → My bookings in two tabs of one browser context → the access
//   cookie ends in both at once (one cookie jar) → both tabs load again, and every POST /v1/auth/refresh waits in the
//   browser until both tabs have reached their refresh → let through → both tabs stay signed in on one refresh
//
// The API has no grace window for a rotated refresh token (ota/backend/src/identity/sessions.service.ts): a second
// refresh that presents the same `__Host-vx_rt` is a reuse, which revokes the session's family and clears both
// cookies, so both tabs end on the sign-in page. The SDK in cookie mode runs each refresh under the origin's Web Lock
// (`navigator.locks`, COOKIE_REFRESH_LOCK) from before its request until its answer is in, so the second tab waits
// for the first tab's refresh and then sends its calls once more with the new cookies, without a refresh of its own.
// Before the fix the second tab sent its refresh at once: the journey holds both and lets them through together (the
// API answered the second `401 REFRESH_TOKEN_REUSED`, and both tabs were signed out); with it, the second tab never
// sends one, and the journey lets the first one through once the second tab waits for the lock.
//
// The OTA backend has neither a test clock nor a configurable token lifetime, so the 15 minutes are made on the
// cookies, as the account journey does (account-bookings.e2e.ts, OADR-0006 point 5 as revised on 2026-10-29): the
// access cookie is removed from the browser context, as the browser removes it when its Max-Age of 900 s ends, and the
// API answers the refresh cookie alone with `401 TOKEN_EXPIRED`. The customer signs up through the OTA API in the
// context (`auth.signUp`, as the sign-up page's SDK calls it; the demo OTA opens the session at once), so the two tabs
// share its httpOnly cookies. The context sends an end-user IP of its own (`X-Forwarded-For`), so the per-IP sign-up
// limit counts this journey alone. No sleep: the journey waits for the held requests, for the second tab's pending
// lock request (`navigator.locks.query()`) and for what the pages show. The storefront guards watch the context; axe
// runs on both tabs.
import type { Page, Route } from "@playwright/test";
import { uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import { ACCESS_COOKIE, REFRESH_COOKIE, StorefrontApi } from "../../support/ota";
import { newPassword } from "../../support/seed";
import { expect, test } from "../../support/storefront-guards";

/** The Web Lock every cookie-mode refresh of the SDK runs under (`COOKIE_REFRESH_LOCK`, ota/sdk/src/internal/session.js). */
const COOKIE_REFRESH_LOCK = "velexis-sdk:cookie-refresh";

/** The customer of the journey: synthetic, with a password made for this run. */
const CUSTOMER = Object.freeze({ firstName: "Tess", lastName: "Twotabs" });

/** What My bookings shows a customer without bookings once `bookings.list` has answered (pages-account.md §2). */
const EMPTY_UPCOMING = "No upcoming trips";

/** One answer of the OTA API that a tab saw, without its body. */
interface SeenAnswer {
  readonly tab: "first" | "second";
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | undefined;
}

/** Records every answer of the OTA API that `page` sees into `into`, with the error code of an error answer. */
function recordApiAnswers(page: Page, tab: SeenAnswer["tab"], into: Promise<SeenAnswer>[]): void {
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (!pathname.startsWith("/api/v1/")) {
      return;
    }
    const base = {
      tab,
      method: response.request().method(),
      path: pathname.slice(4),
      status: response.status(),
    };
    into.push(
      response.text().then(
        (body) => {
          let code: string | undefined;
          if (response.status() >= 400) {
            try {
              code = (JSON.parse(body) as { error?: { code?: string } }).error?.code;
            } catch {
              code = undefined;
            }
          }
          return { ...base, code };
        },
        () => ({ ...base, code: undefined }),
      ),
    );
  });
}

/**
 * Whether `page` has a request for the SDK's refresh lock that waits for another holder; `false` while the page's
 * document is being replaced (the evaluation then fails, and the poll asks again).
 */
async function waitsForRefreshLock(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async (name) => {
      if (!("locks" in navigator)) {
        return false;
      }
      const { pending = [] } = await navigator.locks.query();
      return pending.some((lock) => lock.name === name);
    }, COOKIE_REFRESH_LOCK);
  } catch {
    return false;
  }
}

/** Signs a new customer up through the OTA API in `api`'s context; the demo OTA opens the session at once. */
async function signUp(api: StorefrontApi): Promise<void> {
  const config = (await api.call("getStorefront", "GET", "/v1/storefront")) as {
    legal?: { termsVersion?: string | null };
  };
  const termsVersion = config.legal?.termsVersion;
  await api.call(
    "signUp",
    "POST",
    "/v1/auth/sign-up",
    {
      email: uniqueEmail("ki003-two-tabs"),
      password: newPassword(),
      firstName: CUSTOMER.firstName,
      lastName: CUSTOMER.lastName,
      marketingConsent: false,
      ...(typeof termsVersion === "string" && termsVersion !== "" ? { termsVersion } : {}),
    },
    201,
  );
}

/** Waits until `page` has settled: My bookings has listed the customer's trips, or the page went on to sign-in. */
async function settled(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("main")
      .getByText(EMPTY_UPCOMING, { exact: true })
      .or(page.getByRole("heading", { level: 1, name: "Sign in" })),
  ).toBeVisible();
}

/** Expects `page` to show My bookings to the signed-in customer. */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/bookings\.html$/);
  await expect(page.getByRole("main").getByText(EMPTY_UPCOMING, { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toContainText(`Hi, ${CUSTOMER.firstName}`);
}

test("two tabs whose access cookie ended together refresh the session once, one after the other, and both stay signed in [FIX-W67-KI003 AC1] [FIX-W67-KI003 AC2]", async ({
  context,
  page: first,
  guards,
}) => {
  const ip = uniqueTestIp();
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
  const api = new StorefrontApi(context, ip);
  await signUp(api);
  const second = await context.newPage();
  for (const tab of [first, second]) {
    await tab.goto("/bookings.html");
    await expectSignedIn(tab);
  }
  const refreshCookie = await api.cookie(REFRESH_COOKIE);
  expect(refreshCookie === undefined, `${REFRESH_COOKIE} after the sign-up`).toBe(false);

  // The access cookie ends in both tabs at once: one browser, one cookie jar.
  await context.clearCookies({ name: ACCESS_COOKIE });
  /** The refreshes held in the browser until both tabs have reached their refresh; later ones pass at once. */
  const held: Route[] = [];
  let letThrough = false;
  await context.route(
    (url) => url.pathname === "/api/v1/auth/refresh",
    async (route) => {
      if (letThrough) {
        await route.continue();
      } else {
        held.push(route);
      }
    },
  );
  const seen: Promise<SeenAnswer>[] = [];
  recordApiAnswers(first, "first", seen);
  recordApiAnswers(second, "second", seen);

  await first.reload({ waitUntil: "commit" });
  await expect.poll(() => held.length, { message: "the first tab's refresh" }).toBe(1);
  await second.reload({ waitUntil: "commit" });
  // The second tab at its refresh: with the SDK's lock it waits for the first tab's (its request for the lock is
  // pending); without it, it sends a refresh of its own with the same refresh cookie, which is held as well.
  await expect
    .poll(async () => held.length === 2 || (await waitsForRefreshLock(second)), {
      message: "the second tab at its refresh",
    })
    .toBe(true);
  letThrough = true;
  await Promise.all(held.splice(0).map((route) => route.continue()));
  await settled(first);
  await settled(second);

  // The session was refreshed once, by the first tab; nothing was refused but the expired access.
  const answers = await Promise.all(seen);
  expect(
    answers.filter((answer) => answer.path === "/v1/auth/refresh"),
    "the refreshes of both tabs",
  ).toEqual([{ tab: "first", method: "POST", path: "/v1/auth/refresh", status: 200, code: undefined }]);
  expect(answers.filter((answer) => answer.code === "TOKEN_EXPIRED").length).toBeGreaterThan(0);
  expect(
    answers.filter((answer) => answer.status === 401 && answer.code !== "TOKEN_EXPIRED"),
    "refusals other than the expired access",
  ).toEqual([]);
  for (const tab of [first, second]) {
    await expectSignedIn(tab);
  }
  expect((await api.cookie(REFRESH_COOKIE)) === refreshCookie, `${REFRESH_COOKIE} rotated`).toBe(false);

  // The session lives on at the API: a page loaded again in the second tab is signed in without another refresh.
  const before = (await Promise.all(seen)).length;
  await second.reload();
  await expectSignedIn(second);
  const later = (await Promise.all(seen)).slice(before);
  expect(
    later.filter((answer) => answer.status >= 400 || answer.path === "/v1/auth/refresh"),
    "refusals and refreshes of the page loaded again",
  ).toEqual([]);
  await guards.checkA11y(second);
  await guards.checkA11y(first);
});
