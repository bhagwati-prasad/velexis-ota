# OADR-0012: Storefront settings, assets and content pages

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when OTAs ask for custom CSS or richer page layouts, or when an image processing library is added to the stack.
**Revisions:** 2026-10-12 (planning review): point 7 caches only the caller-independent part of `storefront.get`, because point 3 and the airline-card method make the response differ per caller. 2026-10-30 (lead decisions (1e), (1f) and (2a), recorded by FIX-W34-OTA): point 2's "a new upload is a new id" reads that the same bytes again answer the existing asset of their kind and `409 CONFLICT` `asset_exists` for another kind; point 3 records the edge's own CSP of the images, the upload route's body limit at the edge and the scope guard's answers of `getPublicAsset`; the storefront context's public reads import nothing of the settings context (dated revisions under points 2 and 3). 2026-10-30 (lead decision (2c) of the day's second batch, recorded by FIX-W35-OTA): point 7's pages cache key `t:<tenantId>:<env>:pages:<locale>`, proposed by OBE-072, is confirmed, and the stricter page checks that OBE-072 built (trimmed titles without control characters; the extra `markdown_not_allowed` cases) are named in the OpenAPI descriptions of the pages operations (dated revision under points 5 and 7).

## Context

The hosted storefront is one static build for every OTA; branding, locales, currencies, features, legal links and the payment configuration come from `storefront.get` at runtime ([ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)). Its CSP allows images, styles and fonts from its own origin only, and OTA logos must be "uploaded through the OTA admin and served same-origin". The storefront never uses `innerHTML` with data ([`conventions.md` §4](../../../docs/mvp/conventions.md#4-vanilla-storefront-otafrontend)). The contract's `StorefrontBranding` has URL fields including `customCssUrl`, and the baseline `storefront_settings` lacks columns for several `StorefrontConfig` fields. OTAs without a website also need hosted terms, privacy and FAQ pages.

## Decision

1. **Settings** stay in the single `storefront_settings` row; migration `0002` adds the missing contract fields ([`../data-model.md`](../data-model.md) §3.4). The OTA admin edits them through `console.settings.storefront.get/update` with `If-Match`.
2. **Assets** are uploaded through `console.settings.assets.upload` into `storefront_assets` and the `StorageAdapter` (`tenant_<key>/assets/<sha256>.<ext>`):
   - PNG, JPEG, WebP (and ICO for favicons) only, sniffed from the bytes, at most 1 MB, logos at most 2000 × 2000;
   - **no SVG** (a same-origin SVG opened directly can run script) and **no CSS**;
   - immutable: a new upload is a new id; settings reference assets by id with `RESTRICT` foreign keys.

   **2026-10-30 (lead decision (1e), recorded by FIX-W34-OTA; accepted as OBE-071 built it): the same bytes again.** The storage key is the file's SHA-256 (`tenant_<key>/assets/<sha256>.<ext>`) and `storage_key` stays unique: one row holds one file, and there is no reference counting of files. So "a new upload is a new id" holds for new bytes only: an upload of the same bytes for the same kind answers the existing asset (its id, no second row; its file is written again, which repairs a file lost to a failed delete), and the same bytes for another kind answer `409 CONFLICT` with `details.reason = "asset_exists"`, `assetId` and `kind` (the OTA admin says "this file is already your <kind>", OAD-014). An asset id still never changes content, so the immutable cache of point 3 holds.
3. **Public asset URLs** are `/v1/assets/<tenantKey>/<assetId>.<ext>`, served by the API with `Cache-Control: public, max-age=31536000, immutable`, `nosniff` and `Content-Security-Policy: default-src 'none'`. `storefront.get` returns same-origin paths (`/api/v1/assets/…`) to the edge, so `img-src 'self'` holds, and absolute `api.ota.example.com` URLs to key callers.

   **2026-10-30 (lead decisions (1f), (2a), (2b) and (2c), recorded by FIX-W34-OTA).**
   - *The images' own CSP at the edge.* Since FIX-W34-SHARED the storefront hosts' edge (Caddy) keeps `getPublicAsset`'s own `Content-Security-Policy: default-src 'none'` on `/api/v1/assets/*` instead of putting the storefront's page CSP on it, so an image opened directly from the storefront's origin runs and loads nothing there either.
   - *Uploads above 1 MB at the edge.* The upload's body is the image (at most 1 MB) and its multipart framing, so a 1 MB image is a body above 1 MB: the OTA API host accepts upload bodies up to 1100 KiB on `POST /v1/console/settings/assets` only, every other route keeps its 1 MB limit (FIX-W34-SHARED), and the API itself reads the upload's body up to 1 MB and 16 KB (`MULTIPART_BODY_LIMITS`; a larger one is `422 ASSET_INVALID` `size`). The OTA admin's server action takes a 2 MB body for its upload (OAD-014).
   - *A credential sent along.* `getPublicAsset` is public (`security: []`), but a request that brings a credential is classified as on every route, and the guards keep their answers for it: the scope guard's `403 SCOPE_NOT_ALLOWED` (a caller or `X-Velexis-Scope` the operation does not take, such as the OTA admin's service key or `console` asked for with a publishable key) and the caller guard's `403 ORIGIN_NOT_ALLOWED` (its key check: a publishable key sent from a browser `Origin` outside its allow-list), as for `downloadFile`; both are in its `x-error-codes` (lead decision (1f): accepted as OBE-071 built it). A request without a credential gets the image or `404`.
   - *The module rule.* The storefront context's public reads live in `src/storefront` and import nothing of `src/settings`: `getPublicAsset` reads the asset row through the storefront's own repository and `TenantTx` and the file through the StorageAdapter in `public-assets.service.ts`, and its controller is registered in `StorefrontModule` (FIX-W34-OTA); the public content pages of OBE-072 follow the same rule. The settings context, which uploads and edits what the storefront reads, may import the storefront's repository, mapper and parser, never the reverse; `src/storefront/module-direction.test.ts` fails on an import of `src/settings` under `src/storefront`.
4. **Theme.** Colours (`#RRGGBB`), a corner-radius style and fonts chosen from the fonts bundled with the storefront build (open licences, served from the storefront origin). The storefront applies them as CSS custom properties set with `style.setProperty`, never by injecting CSS text. `customCssUrl` is always `null` in the MVP.
5. **Content pages** live in `storefront_pages` (one row per slug and locale) and are written in a **Markdown subset**: headings 2–4, paragraphs, bold, italic, bullet and numbered lists, links (`https:`, `mailto:`, `tel:`, relative `/p/<slug>`), and images referencing `page_image` assets. The server validates on save (`422` with the line) and parses on read into a block tree (`storefront.getPage` returns `blocks`), which the storefront renders with `createElement` and `textContent`. One small parser in the backend (no Markdown library that emits HTML).

   **2026-10-30 (lead decision (2c) of the day's second batch, recorded by FIX-W35-OTA): the stricter checks in the contract.** The checks OBE-072 built beyond this point are part of the pages operations' OpenAPI descriptions (descriptions only; no schema, status or code changes): a title is stored trimmed, and one that is blank once trimmed or holds a control character is `400 VALIDATION_FAILED` at `/title`; besides the constructs above, `+ ` bullets, `1) ` numbers, setext headings, empty headings and list items, link titles, links without text, control characters and inline nesting deeper than 8 are `422 UNPROCESSABLE` `markdown_not_allowed` with the line they start on (`StorefrontPageMarkdown`, `consoleCreateStorefrontPage`, `consoleUpdateStorefrontPage`; [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §2.4).
6. **Legal links** in settings can point to an external URL or to a page slug; a linked page cannot be deleted. Sign-up records `terms_version` and `privacy_version` in `customer_consents`.
7. **Caching.** `storefront.get` and pages are cached in Redis per tenant, environment and locale for 5 minutes (`t:<tenantId>:<env>:sf:<locale>`) and deleted on every settings or page change. Because `storefront.get` differs per caller (point 3, and `airline_card` in `payment.supportedMethods` and `payment.airlineCard` for the edge only, [OADR-0017](0017-airline-card-form-isolation.md) point 7), the cache holds only the caller-independent part: asset references as ids and the airline-card availability as a flag. The mapper adds the asset URLs and the airline-card fields for the caller on every request, so whichever caller fills the cache first never decides what the others get. A test makes a `pk_` call and then an edge call on one cache fill and checks both answers; the storefront keeps its own 5-minute `sessionStorage` copy, so a change is visible within about 5 minutes.

   **2026-10-30 (OBE-072; confirmed by lead decision (2c) of the day's second batch, recorded by FIX-W35-OTA): the pages' key.** The key in brackets is storefront.get's. The pages are cached per tenant, environment and locale too, in a hash of their own beside it, `t:<tenantId>:<env>:pages:<locale>` (5 minutes): a `list` field and a `page:<slug>` field per page read, the image URLs added per request as for storefront.get. Every console page change and every settings change deletes the hashes of every supported locale in both environments ([`../architecture.md`](../architecture.md) §7, `ota/backend/src/storefront/public-pages.service.ts`).
8. **Test mode banner** is not a setting: the storefront shows it whenever `environment = test`.

## Consequences

### Positive

- The CSP of the hosted storefront stays strict; brand assets cannot carry script or style injection.
- OTAs get a branded storefront and legal pages without writing HTML or hosting files.
- One static build still serves every OTA.
- One cache entry per tenant, environment and locale serves both caller kinds without leaking one caller's view to the other.

### Negative

- No custom CSS or HTML: OTAs with a designer will find the theme limited (they can build their own frontend with the SDK).
- Images are not re-encoded, so metadata (for example EXIF) stays in uploaded files; the admin warns staff.
- A small in-house Markdown parser must be maintained and fuzz-tested.

### Follow-ups

- Image re-encoding and resizing when an image library is accepted for the VM.
- More block types (tables, callouts) if OTAs ask.

## Alternatives considered

- **External logo URLs.** Break the CSP and leak visitor IPs to third parties.
- **Sanitised HTML pages.** A sanitiser is one more dependency and still needs `innerHTML` in the storefront.
- **Custom CSS uploads.** CSS can restyle or hide elements of the payment page, which the PCI controls of ADR-0011 must keep stable.
- **The caller kind in the cache key** (`…:sf:<edge|key>:<locale>`). Also correct, but doubles the entries and the keys every settings change must delete; the per-request decoration is a few lines in the mapper.

## References

- [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md), [ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md), [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C
- [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §2.3–§2.5, §4, [`../data-model-migration-0002.md`](../data-model-migration-0002.md)
