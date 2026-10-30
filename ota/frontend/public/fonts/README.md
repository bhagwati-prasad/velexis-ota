# Bundled storefront fonts (`public/fonts/`)

The fonts an OTA can choose for its storefront (headings and body text) live here as `woff2` files. They are served from the storefront's own origin, so the strict CSP (`font-src 'self'`) holds and no third-party font service sees travellers ([OADR-0015](../../../docs/adr/0015-storefront-build-urls-and-hosting.md) point 8, [README §6](../../README.md#6-theming)).

## Rules

- **Open licences only** (SIL Open Font License 1.1 or Apache 2.0). Put the licence text next to the files: `public/fonts/<family>/OFL.txt` (or `LICENSE.txt`).
- **`woff2` only**, one file per weight and style actually used (400 and 600 or 700 are usually enough), Latin subset unless a market needs more.
- **One folder per family** in kebab case: `public/fonts/inter/inter-400.woff2`.
- **Declared in [`src/styles/fonts.css`](../../src/styles/fonts.css)** with `font-display: swap` and an absolute URL (`url("/fonts/inter/inter-400.woff2")`). Vite copies `public/` to `dist/` as it is, and `build.assetsInlineLimit = 0` keeps every font a file, never a `data:` URI.
- **The family names are an enum** in the OTA API (`StorefrontSettings.branding.fonts`), shared by the OTA admin, the backend validation and the storefront. A unit test (`test/fonts.test.js`, task OFE-020) fails when `fonts.css` and the enum differ, when a declared file is missing, is not a `woff2` file or has no licence next to it, or when two families exceed the page budget.
- **Budget**: at most 2 families and 120 KB of fonts per page ([README §9](../../README.md#9-performance-budgets)). A page downloads the faces it uses: the heading family's 600 and the body family's 400 and 600; the largest pair (Playfair Display headings on Merriweather text) is about 118 KB.

## What is bundled (OFE-020)

Each family has a 400 face (body text; `font-medium` uses it too) and a 600 face (`font-semibold` and the headings); Lato has no 600, so its 700 serves `font-semibold`. Italic text is the browser's slanted face. The files are the Latin-subset `woff2` files of the [Fontsource](https://fontsource.org) npm packages below, renamed `<family>-<weight>.woff2`; `OFL.txt` is the package's `LICENSE` file (SIL Open Font License 1.1, with each family's copyright line). They were taken from the tarballs `npm pack` downloaded (npm checks each against the registry's integrity hash); to update a family, take the same files from a newer version, update this table and run `pnpm --filter @velexis/ota-frontend test` (`test/fonts.test.js`).

| Family (enum value) | File | From `@fontsource/<folder>`, `files/` | SHA-256 |
|---|---|---|---|
| Inter | `inter/inter-400.woff2` | `inter@5.3.0`: `inter-latin-400-normal.woff2` | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` |
| Inter | `inter/inter-600.woff2` | `inter@5.3.0`: `inter-latin-600-normal.woff2` | `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a` |
| Roboto | `roboto/roboto-400.woff2` | `roboto@5.3.0`: `roboto-latin-400-normal.woff2` | `425c0713a8176f92273d378599c7eac57de7fafabd4bd0ed457b70eb8f80d371` |
| Roboto | `roboto/roboto-600.woff2` | `roboto@5.3.0`: `roboto-latin-600-normal.woff2` | `3eac5e2f468629b4673394bb25a387aba117e0dfa646b7f371a2cbd2bbf91d87` |
| Open Sans | `open-sans/open-sans-400.woff2` | `open-sans@5.3.0`: `open-sans-latin-400-normal.woff2` | `0e44026ad31376af1b56593cd4acb4f353f8e8789c51759e18f64578e4ef296a` |
| Open Sans | `open-sans/open-sans-600.woff2` | `open-sans@5.3.0`: `open-sans-latin-600-normal.woff2` | `a97a6ed7ef9f75c495e9224f5c59b2271d826e4a4345b738b390b0c76cc9f412` |
| Lato | `lato/lato-400.woff2` | `lato@5.3.0`: `lato-latin-400-normal.woff2` | `918b7dc3e2e2d015c16ce08b57bcb64d2253bafc1707658f361e72865498e537` |
| Lato | `lato/lato-700.woff2` | `lato@5.3.0`: `lato-latin-700-normal.woff2` | `c447dd7677b419db7b21dbdfc6277c7816a913ffda76fd2e52702df538de0e49` |
| Montserrat | `montserrat/montserrat-400.woff2` | `montserrat@5.3.0`: `montserrat-latin-400-normal.woff2` | `e66bcd2761ab6924b25ce70dafe10e57a39193c4fea1516730bd9cb5240af6c8` |
| Montserrat | `montserrat/montserrat-600.woff2` | `montserrat@5.3.0`: `montserrat-latin-600-normal.woff2` | `d857325c360f7128b347ca924c1974967aaa886ba47dad22e4042d6c38b26a83` |
| Source Sans 3 | `source-sans-3/source-sans-3-400.woff2` | `source-sans-3@5.3.1`: `source-sans-3-latin-400-normal.woff2` | `0f73f35e08cde0a2f10c109c6e01d71459d97e4099ecd9a50f1b6c0209e4de2b` |
| Source Sans 3 | `source-sans-3/source-sans-3-600.woff2` | `source-sans-3@5.3.1`: `source-sans-3-latin-600-normal.woff2` | `14527d193b0e30bc32ef931549a246cdfd286573bb12869b7e052b8101a39d38` |
| Merriweather | `merriweather/merriweather-400.woff2` | `merriweather@5.3.0`: `merriweather-latin-400-normal.woff2` | `66f5bd22d738a801a9e58d71920559743b0baaced04be299e3c4feca3dce3556` |
| Merriweather | `merriweather/merriweather-600.woff2` | `merriweather@5.3.0`: `merriweather-latin-600-normal.woff2` | `3ef93c94387a5a08bbe3115b15b912ea9ed27cae4d5b7db869dc07c443fadc4c` |
| Playfair Display | `playfair-display/playfair-display-400.woff2` | `playfair-display@5.3.0`: `playfair-display-latin-400-normal.woff2` | `1fe9ad5d8b2ebd8ecb8fbd05bed1e3fdfa52dae3f1a04e1c219918442fe9394d` |
| Playfair Display | `playfair-display/playfair-display-600.woff2` | `playfair-display@5.3.0`: `playfair-display-latin-600-normal.woff2` | `5d2286941a6b02a29387efa94809a064f8917598eafa67b938261cf13bb887cd` |

This file is documentation only: the build removes Markdown files copied from `public/`, so it is not deployed.
