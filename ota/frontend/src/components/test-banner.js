// The "Test mode" banner (partials/test-banner.html, ota/frontend/docs/pages.md §2, OADR-0012 point 8). It is not a
// setting: the storefront shows it whenever `storefront.get` answers `environment = test`, so travellers know that
// nothing they book or pay there is real. The partial is hidden until this component shows it, and every page includes
// it (test/boot.test.js checks the pages). Pages of a test storefront are also kept out of search engines (boot()).

/**
 * Mounts the banner component on `root`: the `[data-slot="test-banner"]` element itself or the element that holds it.
 * Shown for `environment = "test"`, hidden otherwise.
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
  const update = (/** @type {{ environment: string }} */ { environment }) => {
    if (banner) {
      banner.hidden = environment !== "test";
    }
  };
  update(props);
  return {
    update,
    destroy() {
      if (banner) {
        banner.hidden = true;
      }
    },
  };
}
