# OADR-0012: Storefront settings, assets and content pages

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when OTAs ask for custom CSS or richer page layouts, or when an image processing library is added to the stack.

## Context

The hosted storefront is one static build for every OTA; branding, locales, currencies, features, legal links and the payment configuration come from `storefront.get` at runtime ([ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)). Its CSP allows images, styles and fonts from its own origin only, and OTA logos must be "uploaded through the OTA admin and served same-origin". The storefront never uses `innerHTML` with data ([`conventions.md` §4](../../../docs/mvp/conventions.md#4-vanilla-storefront-otafrontend)). The contract's `StorefrontBranding` has URL fields including `customCssUrl`, and the baseline `storefront_settings` lacks columns for several `StorefrontConfig` fields. OTAs without a website also need hosted terms, privacy and FAQ pages.

## Decision

1. **Settings** stay in the single `storefront_settings` row; migration `0002` adds the missing contract fields ([`../data-model.md`](../data-model.md) §3.4). The OTA admin edits them through `console.settings.storefront.get/update` with `If-Match`.
2. **Assets** are uploaded through `console.settings.assets.upload` into `storefront_assets` and the `StorageAdapter` (`tenant_<key>/assets/<sha256>.<ext>`):
   - PNG, JPEG, WebP (and ICO for favicons) only, sniffed from the bytes, at most 1 MB, logos at most 2000 × 2000;
   - **no SVG** (a same-origin SVG opened directly can run script) and **no CSS**;
   - immutable: a new upload is a new id; settings reference assets by id with `RESTRICT` foreign keys.
3. **Public asset URLs** are `/v1/assets/<tenantKey>/<assetId>.<ext>`, served by the API with `Cache-Control: public, max-age=31536000, immutable`, `nosniff` and `Content-Security-Policy: default-src 'none'`. `storefront.get` returns same-origin paths (`/api/v1/assets/…`) to the edge, so `img-src 'self'` holds, and absolute `api.ota.example.com` URLs to key callers.
4. **Theme.** Colours (`#RRGGBB`), a corner-radius style and fonts chosen from the fonts bundled with the storefront build (open licences, served from the storefront origin). The storefront applies them as CSS custom properties set with `style.setProperty`, never by injecting CSS text. `customCssUrl` is always `null` in the MVP.
5. **Content pages** live in `storefront_pages` (one row per slug and locale) and are written in a **Markdown subset**: headings 2–4, paragraphs, bold, italic, bullet and numbered lists, links (`https:`, `mailto:`, `tel:`, relative `/p/<slug>`), and images referencing `page_image` assets. The server validates on save (`422` with the line) and parses on read into a block tree (`storefront.getPage` returns `blocks`), which the storefront renders with `createElement` and `textContent`. One small parser in the backend (no Markdown library that emits HTML).
6. **Legal links** in settings can point to an external URL or to a page slug; a linked page cannot be deleted. Sign-up records `terms_version` and `privacy_version` in `customer_consents`.
7. **Caching.** `storefront.get` and pages are cached in Redis per tenant, environment and locale for 5 minutes and deleted on every settings or page change; the storefront keeps its own 5-minute `sessionStorage` copy, so a change is visible within about 5 minutes.
8. **Test mode banner** is not a setting: the storefront shows it whenever `environment = test`.

## Consequences

### Positive

- The CSP of the hosted storefront stays strict; brand assets cannot carry script or style injection.
- OTAs get a branded storefront and legal pages without writing HTML or hosting files.
- One static build still serves every OTA.

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

## References

- [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md), [ADR-0017](../../../docs/mvp/adr/0017-email-documents-storage.md), [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C
- [`../api-changes-console-and-internal.md`](../api-changes-console-and-internal.md) §2.3–§2.5, §4, [`../data-model-migration-0002.md`](../data-model-migration-0002.md)
