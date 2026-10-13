# Bundled storefront fonts (`public/fonts/`)

The fonts an OTA can choose for its storefront (headings and body text) live here as `woff2` files. They are served from the storefront's own origin, so the strict CSP (`font-src 'self'`) holds and no third-party font service sees travellers ([OADR-0015](../../../docs/adr/0015-storefront-build-urls-and-hosting.md) point 8, [README §6](../../README.md#6-theming)).

## Rules

- **Open licences only** (SIL Open Font License 1.1 or Apache 2.0). Put the licence text next to the files: `public/fonts/<family>/OFL.txt` (or `LICENSE.txt`).
- **`woff2` only**, one file per weight and style actually used (400 and 600 or 700 are usually enough), Latin subset unless a market needs more.
- **One folder per family** in kebab case: `public/fonts/inter/inter-400.woff2`.
- **Declared in [`src/styles/fonts.css`](../../src/styles/fonts.css)** with `font-display: swap` and an absolute URL (`url("/fonts/inter/inter-400.woff2")`). Vite copies `public/` to `dist/` as it is, and `build.assetsInlineLimit = 0` keeps every font a file, never a `data:` URI.
- **The family names are an enum** in the OTA API (`StorefrontSettings.branding.fonts`), shared by the OTA admin, the backend validation and the storefront. A unit test (`test/fonts.test.js`, task OFE-020) fails when `fonts.css` and the enum differ.
- **Budget**: at most 2 families and 120 KB of fonts per page ([README §9](../../README.md#9-performance-budgets)).

This file is documentation only: the build removes Markdown files copied from `public/`, so it is not deployed.
