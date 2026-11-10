// The "Test mode" banner (partials/test-banner.html, ota/frontend/docs/pages.md §2, OADR-0012 point 8). It is not a
// setting: the storefront shows it whenever `storefront.get` answers `environment = test` (or a value this build does
// not know, OFE-021), so travellers know that nothing they book or pay there is real. The partial is hidden until this
// component shows it, and every page includes it (test/boot.test.js checks the pages). Pages of a test storefront are
// also kept out of search engines (boot()).
//
// Where it shows (OFE-028, ota/docs/storefront-accessibility.md §3): fixed to the bottom of the window, over the page,
// so that showing it after `storefront.get` has answered moves nothing that is already painted (no layout shift). While
// it shows, its height is the root element's `--vx-test-banner-height`, measured at once and again whenever the banner
// changes size (its text wraps on a narrow screen, a font arrives, the text is zoomed). main.css turns that height into
// space after the end of the page (the root's `padding-bottom`), so the end of every page can be scrolled clear of the
// banner, and into the root's `scroll-padding-bottom`, so the browser scrolls a focused element above the banner
// instead of behind it (WCAG 2.4.11, technique C43). Hidden, it keeps no space: a live storefront has neither banner nor
// space. It stays the first element of the page (before the header) and is a `role="note"`, not a live region, so a
// screen reader reads it once, there.

/** The root element's custom property that holds the height of the shown banner (main.css reserves that space). */
export const HEIGHT_PROPERTY = "--vx-test-banner-height";

/**
 * Mounts the banner component on `root`: the `[data-slot="test-banner"]` element itself or the element that holds it.
 * Hidden only for `environment = "live"`: `test`, and any value this build does not know, shows it, so no page (the
 * airline-card page passes `storefront.get`'s value as it is) looks real unless the API says it is live (OFE-021).
 * @param {ParentNode} root
 * @param {{ environment: "test" | "live" | string }} props
 * @returns {{ update: (props: { environment: string }) => void, destroy: () => void }}
 */
export function mount(root, props) {
  const banner = /** @type {HTMLElement | null} */ (
    "matches" in root && /** @type {Element} */ (root).matches('[data-slot="test-banner"]')
      ? root
      : root.querySelector('[data-slot="test-banner"]')
  );
  const style = banner?.ownerDocument.documentElement.style;
  const View = banner?.ownerDocument.defaultView;
  // The banner's height as the root's custom property while it shows (whole pixels, so no sliver of the page stays
  // under it); none while it is hidden.
  const reserve = () => {
    const height = banner && !banner.hidden ? Math.ceil(banner.getBoundingClientRect().height) : 0;
    if (height > 0) {
      style?.setProperty(HEIGHT_PROPERTY, `${height}px`);
    } else {
      style?.removeProperty(HEIGHT_PROPERTY);
    }
  };
  const resizes =
    banner && View && typeof View.ResizeObserver === "function"
      ? new View.ResizeObserver(() => reserve())
      : null;
  const update = (/** @type {{ environment: string }} */ { environment }) => {
    if (!banner) {
      return;
    }
    banner.hidden = environment === "live";
    reserve();
    if (banner.hidden) {
      resizes?.unobserve(banner);
    } else {
      resizes?.observe(banner);
    }
  };
  update(props);
  return {
    update,
    destroy() {
      if (banner) {
        banner.hidden = true;
        resizes?.disconnect();
        reserve();
      }
    },
  };
}
