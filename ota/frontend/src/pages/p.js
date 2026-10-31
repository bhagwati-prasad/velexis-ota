// Entry module of the content pages (p.html, ota/frontend/docs/pages-account.md §7, OADR-0012 point 5, OADR-0015
// point 4): the OTA's own pages (about, terms, privacy, cookies, refund policy, imprint, FAQ) at `/p/<slug>`, which
// Caddy rewrites to p.html (`rewrite /p/* /p.html` in the storefront block of deploy/caddy/Caddyfile), as the dev
// server and `vite preview` do.
//
// 1. The slug comes from `location.pathname` (lib/url.js `pageSlugFromPath`). A path that names no valid slug shows
//    the not-found content at once, without a request.
// 2. `storefront.getPage({ slug })`: the page's title becomes the `h1` and the document title, and its blocks are
//    built by lib/blocks.js with `createElement` and text nodes only (links checked again, images only from the
//    OTA's same-origin asset paths). The article carries the page's `locale` as its `lang`.
// 3. `404 NOT_FOUND` (no published page of the slug) shows the 404 page's content in place: the HTML is static, so the
//    status stays 200, and the page adds `noindex`. Any other failure shows the shared state, with Retry unless the
//    storefront is suspended or unknown, or the call was refused; as on the other pages, the state's text becomes the
//    document title and the live region announces it.
//
// The footer of every page lists the published pages that have `showInFooter` (components/footer.js).

import { boot, markNoindex, renderState } from "../boot.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { renderBlocks } from "../lib/blocks.js";
import { pageStateFor } from "../lib/errors.js";
import { pageSlugFromPath } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontPageContent"]} StorefrontPageContent */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {{ storefront: Pick<VelexisClient["storefront"], "getPage"> }} PageClient */

/** Failures of `storefront.getPage` without Retry: trying again changes nothing. */
const FINAL_STATES = new Set(["suspended", "unknown-host", "forbidden", "feature-disabled"]);
/** Failures that mean the page does not exist (a slug the API refuses is no page either). */
const NOT_FOUND_STATES = new Set(["not-found", "validation"]);
/** A language tag for the article's `lang` (`LocaleCode`: `en`, `fr-CA`, …). */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/**
 * Runs the content page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page
 * has no content area, else `{ done, destroy }`: `done` settles once the page, the not-found content or a state is
 * shown.
 * @param {{ config: StorefrontConfig, client: PageClient }} context
 * @param {{ doc?: Document, location?: Location }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-content-page]"));
  if (!main) {
    return null;
  }
  const location = env.location ?? (doc.defaultView ?? globalThis).location;
  const article = /** @type {HTMLElement} */ (main.querySelector("[data-page-article]"));
  const title = /** @type {HTMLElement} */ (main.querySelector("[data-page-title]"));
  const body = /** @type {HTMLElement} */ (main.querySelector("[data-page-body]"));
  const stateBox = /** @type {HTMLElement} */ (main.querySelector("[data-page-state]"));
  const loading = /** @type {HTMLElement | null} */ (main.querySelector("[data-page-loading]"));
  const notFound = /** @type {HTMLElement} */ (main.querySelector("[data-page-not-found]"));
  const live = mountLiveRegion(doc.body);
  const controller = new AbortController();
  let destroyed = false;

  /** Shows one of the page's views and hides the others. */
  const show = (/** @type {"article" | "loading" | "state" | "not-found"} */ view) => {
    article.hidden = view !== "article";
    if (loading) {
      loading.hidden = view !== "loading";
    }
    notFound.hidden = view !== "not-found";
    if (view !== "state") {
      stateBox.replaceChildren();
    }
  };

  const showNotFound = (/** @type {boolean} */ focus) => {
    show("not-found");
    const heading = /** @type {HTMLElement | null} */ (notFound.querySelector("h1"));
    doc.title = heading?.textContent?.trim() || doc.title;
    markNoindex(doc);
    if (focus) {
      heading?.focus();
    }
  };

  const showPage = (
    /** @type {StorefrontPageContent} */ content,
    /** @type {string} */ slug,
    /** @type {boolean} */ focus,
  ) => {
    const text = typeof content?.title === "string" && content.title.trim() !== "" ? content.title : slug;
    title.textContent = text;
    doc.title = text;
    body.replaceChildren(
      renderBlocks(content?.blocks, { doc, tenantKey: context.config?.tenantKey ?? null }),
    );
    if (typeof content?.locale === "string" && LANGUAGE_TAG.test(content.locale)) {
      article.lang = content.locale;
    } else {
      article.removeAttribute("lang");
    }
    show("article");
    if (focus) {
      title.focus();
    }
  };

  /**
   * Asks the API for the page and shows it, the not-found content or a state.
   * @param {string} slug
   * @param {boolean} focus move the focus to what is shown (after a Retry)
   * @returns {Promise<void>}
   */
  const load = async (slug, focus) => {
    show("loading");
    /** @type {StorefrontPageContent} */
    let content;
    try {
      content = await context.client.storefront.getPage({ slug }, { signal: controller.signal });
    } catch (error) {
      if (destroyed) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "aborted") {
        return;
      }
      if (NOT_FOUND_STATES.has(state.name)) {
        showNotFound(focus);
        return;
      }
      show("state");
      doc.title = state.message;
      live.announce(state.message);
      const requestId =
        state.name === "unexpected" && error instanceof Error && "requestId" in error
          ? /** @type {{ requestId: unknown }} */ (error).requestId
          : null;
      renderState(stateBox, state, {
        support: context.config?.support ?? null,
        requestId: typeof requestId === "string" ? requestId : null,
        focus,
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => void load(slug, true).catch(report) }),
      });
      return;
    }
    if (!destroyed) {
      showPage(content, slug, focus);
    }
  };

  const slug = pageSlugFromPath(location.pathname);
  /** @type {Promise<void>} */
  let done;
  if (slug === null) {
    showNotFound(false);
    done = Promise.resolve();
  } else {
    done = load(slug, false);
  }
  return {
    done,
    destroy() {
      destroyed = true;
      controller.abort();
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient }} */ (/** @type {unknown} */ (context)),
    )?.done.catch(report);
  } catch (error) {
    report(error);
  }
});
