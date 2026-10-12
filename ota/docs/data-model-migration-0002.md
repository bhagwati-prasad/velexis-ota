# Tenant migration 0002: exact SQL

This document holds the exact SQL of `ota/backend/migrations/tenant/0002_add_mvp_tenant_deltas.sql`, the only tenant migration of the MVP plan. The reasons for each change are in [`data-model.md`](data-model.md) §3. The task that creates the file copies the SQL block below verbatim, runs it on an empty and on a populated tenant schema, regenerates the Kysely types and adds the integration tests listed at the end.

Related: [`data-model.md`](data-model.md), [baseline `tenant.sql`](../../docs/velexis-sdk/db/tenant.sql), [`conventions.md` §9](../../docs/mvp/conventions.md#9-database-migrations), [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md), [OADR-0007](adr/0007-tenant-migration-runner-and-provisioning-worker.md).

## 1. Notes before the SQL

- The runner executes the file in one transaction with `lock_timeout = 5s`, with the `search_path` set to the tenant schema and `reference`. Names are unqualified.
- The baseline declares the provider and method checks inline, so PostgreSQL named them `payments_provider_check` and `payments_method_check`. The migration replaces them with named constraints (`…_ck`) using the expand pattern: add `NOT VALID`, drop the old one, `VALIDATE`.
- Adding a column with a constant default does not rewrite the table on PostgreSQL 16.
- No `GRANT`: the provisioning step gave `velexis_ota_app` default privileges on tables that `velexis_migrator` creates in the schema.
- Phase `expand` only: nothing is dropped; the code that uses the new columns tolerates their absence until the fan-out has finished (N-1 rule).

## 2. The migration

```sql
-- velexis:phase expand
-- MVP tenant deltas: airline-card payments, checkout pricing mode, booking reconciliation, storefront content, pages and assets.

-- ===================================================================================================
-- 1. Payments: the airline-card method (ADR-0011, OADR-0004)
-- ===================================================================================================
ALTER TABLE payments ADD CONSTRAINT payments_provider_ck
  CHECK (provider IN ('stripe','adyen','checkout_com','paypal','manual','airline')) NOT VALID;
ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments VALIDATE CONSTRAINT payments_provider_ck;

ALTER TABLE payments ADD CONSTRAINT payments_method_ck
  CHECK (method IN ('card','apple_pay','google_pay','paypal','bank_transfer','agency_credit','cash','airline_card')) NOT VALID;
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments VALIDATE CONSTRAINT payments_method_ck;

ALTER TABLE payments ADD CONSTRAINT payments_airline_card_ck CHECK (
  ((provider = 'airline') = (method = 'airline_card'))
  AND (provider <> 'airline' OR (
        provider_payment_id IS NULL
    AND provider_customer_id IS NULL
    AND card_exp_month IS NULL
    AND card_exp_year IS NULL
    AND three_ds IS NULL
    AND next_action IS NULL
    AND capture_method = 'automatic'))
) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_airline_card_ck;

COMMENT ON COLUMN payments.provider IS 'Payment service provider: stripe; manual (recorded by staff); airline (card charged by the validating airline through Amadeus formOfPayments, no PSP).';
COMMENT ON COLUMN payments.method IS 'Payment method; airline_card = card passed to the airline through Amadeus (provider = airline): only brand, BIN, last 4 and the outcome are kept.';
COMMENT ON CONSTRAINT payments_airline_card_ck ON payments IS 'Airline-card payments keep no PSP reference, expiry or 3-D Secure data; card numbers and security codes are never stored (ADR-0011).';

-- ===================================================================================================
-- 2. Checkouts: pricing mode (net for airline-card payments)
-- ===================================================================================================
ALTER TABLE checkouts ADD COLUMN pricing_mode text NOT NULL DEFAULT 'markup_rules'
  CONSTRAINT checkouts_pricing_mode_ck CHECK (pricing_mode IN ('markup_rules','net'));
COMMENT ON COLUMN checkouts.pricing_mode IS 'markup_rules = selling prices with markup and OTA fees; net = Amadeus price and Amadeus card fee only (airline_card payments, charged by the airline).';

-- ===================================================================================================
-- 3. Bookings: reconciliation after SUPPLIER_TIMEOUT (OADR-0003)
-- ===================================================================================================
ALTER TABLE bookings ADD COLUMN create_order_started_at timestamptz;
ALTER TABLE bookings ADD COLUMN reconcile_until timestamptz;
ALTER TABLE bookings ADD COLUMN reconcile_attempts smallint NOT NULL DEFAULT 0
  CONSTRAINT bookings_reconcile_attempts_ck CHECK (reconcile_attempts >= 0);
ALTER TABLE bookings ADD COLUMN reconcile_outcome text
  CONSTRAINT bookings_reconcile_outcome_ck CHECK (reconcile_outcome IN ('found','not_found','manual_review'));
ALTER TABLE bookings ADD CONSTRAINT bookings_reconcile_ck
  CHECK (reconcile_until IS NULL OR create_order_started_at IS NOT NULL);

CREATE INDEX bookings_reconcile_idx ON bookings (reconcile_until)
  WHERE status = 'pending' AND reconcile_until IS NOT NULL;

COMMENT ON COLUMN bookings.create_order_started_at IS 'When Flight Create Orders was sent for this booking (claim time); the reconciler searches PNRs created around it.';
COMMENT ON COLUMN bookings.reconcile_until IS 'Set after a supplier timeout: the reconciler looks for the order until this time (create time + 15 minutes).';
COMMENT ON COLUMN bookings.reconcile_attempts IS 'Number of reconciliation checks made (Queue List + by-reference lookups).';
COMMENT ON COLUMN bookings.reconcile_outcome IS 'Result of reconciliation: found (order recorded), not_found (payment voided, booking failed), manual_review (staff decide; airline card).';

-- ===================================================================================================
-- 4. Storefront assets (uploaded brand and page images, served same-origin)
-- ===================================================================================================
CREATE TABLE storefront_assets (
  id                   text PRIMARY KEY CHECK (id LIKE 'ast\_%'),
  kind                 text NOT NULL CHECK (kind IN ('logo','logo_dark','logo_square','favicon','og_image','page_image')),
  content_type         text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','image/x-icon')),
  file_extension       text NOT NULL CHECK (file_extension IN ('png','jpg','webp','ico')),
  file_name            text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  size_bytes           integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  width                integer CHECK (width > 0),
  height               integer CHECK (height > 0),
  storage_key          text NOT NULL UNIQUE,
  content_hash         text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  uploaded_by_staff_id text CHECK (uploaded_by_staff_id LIKE 'stf\_%'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storefront_assets_icon_ck CHECK (content_type <> 'image/x-icon' OR kind = 'favicon')
);
CREATE INDEX storefront_assets_kind_idx ON storefront_assets (kind, created_at DESC);

COMMENT ON TABLE storefront_assets IS 'Images uploaded by OTA staff for the storefront (logos, favicon, Open Graph, page images). Immutable rows; no SVG or CSS.';
COMMENT ON COLUMN storefront_assets.id IS 'Asset id (ast_ + ULID); part of the public immutable URL /v1/assets/<tenant key>/<id>.<ext>.';
COMMENT ON COLUMN storefront_assets.kind IS 'Use of the image; settings reference logo, logo_dark, logo_square, favicon and og_image assets by kind.';
COMMENT ON COLUMN storefront_assets.content_type IS 'MIME type sniffed from the file bytes (never trusted from the upload).';
COMMENT ON COLUMN storefront_assets.file_extension IS 'Extension used in the public URL.';
COMMENT ON COLUMN storefront_assets.file_name IS 'Original file name shown in the console.';
COMMENT ON COLUMN storefront_assets.size_bytes IS 'File size (at most 1 MB).';
COMMENT ON COLUMN storefront_assets.width IS 'Width in pixels read from the file header.';
COMMENT ON COLUMN storefront_assets.height IS 'Height in pixels read from the file header.';
COMMENT ON COLUMN storefront_assets.storage_key IS 'StorageAdapter key, tenant_<key>/assets/<sha256>.<ext>.';
COMMENT ON COLUMN storefront_assets.content_hash IS 'SHA-256 of the file (integrity, de-duplication).';
COMMENT ON COLUMN storefront_assets.uploaded_by_staff_id IS 'Staff id (stf_) by value.';
COMMENT ON COLUMN storefront_assets.created_at IS 'Upload time.';
COMMENT ON COLUMN storefront_assets.updated_at IS 'Equal to created_at (immutable rows).';

-- ===================================================================================================
-- 5. Storefront pages (hosted terms, privacy, FAQ, about)
-- ===================================================================================================
CREATE TABLE storefront_pages (
  id                  text PRIMARY KEY CHECK (id LIKE 'stp\_%'),
  slug                text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64),
  locale              text NOT NULL,
  kind                text NOT NULL DEFAULT 'content'
                      CHECK (kind IN ('content','terms','privacy','cookies','refund_policy','imprint','faq','about')),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body_markdown       text NOT NULL DEFAULT '' CHECK (length(body_markdown) <= 50000),
  is_published        boolean NOT NULL DEFAULT false,
  show_in_footer      boolean NOT NULL DEFAULT false,
  sort_order          integer NOT NULL DEFAULT 100,
  published_at        timestamptz,
  updated_by_staff_id text CHECK (updated_by_staff_id LIKE 'stf\_%'),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storefront_pages_slug_locale_uq UNIQUE (slug, locale),
  CONSTRAINT storefront_pages_published_ck CHECK (NOT is_published OR published_at IS NOT NULL)
);
CREATE INDEX storefront_pages_published_idx ON storefront_pages (locale, sort_order) WHERE is_published;

COMMENT ON TABLE storefront_pages IS 'Content pages of the hosted storefront, edited in the OTA admin and served by storefront.getPage as parsed blocks.';
COMMENT ON COLUMN storefront_pages.id IS 'Page id (stp_ + ULID).';
COMMENT ON COLUMN storefront_pages.slug IS 'URL slug: the storefront shows the page at /p/<slug>.';
COMMENT ON COLUMN storefront_pages.locale IS 'Locale of this version of the page (BCP 47).';
COMMENT ON COLUMN storefront_pages.kind IS 'Purpose; legal kinds can be linked from the legal links of storefront_settings.';
COMMENT ON COLUMN storefront_pages.title IS 'Page title.';
COMMENT ON COLUMN storefront_pages.body_markdown IS 'Body in the allowed Markdown subset (headings, paragraphs, emphasis, lists, links, page images); no HTML.';
COMMENT ON COLUMN storefront_pages.is_published IS 'Only published pages are served to the storefront.';
COMMENT ON COLUMN storefront_pages.show_in_footer IS 'Listed in the storefront footer.';
COMMENT ON COLUMN storefront_pages.sort_order IS 'Order in the footer and page lists (lower first).';
COMMENT ON COLUMN storefront_pages.published_at IS 'First publication time.';
COMMENT ON COLUMN storefront_pages.updated_by_staff_id IS 'Staff id (stf_) of the last editor, by value.';
COMMENT ON COLUMN storefront_pages.version IS 'Optimistic-locking counter (If-Match).';
COMMENT ON COLUMN storefront_pages.created_at IS 'Row creation time.';
COMMENT ON COLUMN storefront_pages.updated_at IS 'Last modification time.';

-- ===================================================================================================
-- 6. Storefront settings: contract fields without a column, airline card, booking queue, assets
-- ===================================================================================================
ALTER TABLE storefront_settings
  ADD COLUMN legal_name                text,
  ADD COLUMN time_zone                 text NOT NULL DEFAULT 'UTC',
  ADD COLUMN default_market            char(2) CONSTRAINT storefront_settings_default_market_ck CHECK (default_market ~ '^[A-Z]{2}$'),
  ADD COLUMN markets                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN support_details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN seo                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN consent                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN terms_version             text,
  ADD COLUMN privacy_version           text,
  ADD COLUMN airline_card_enabled_test boolean NOT NULL DEFAULT false,
  ADD COLUMN airline_card_enabled_live boolean NOT NULL DEFAULT false,
  ADD COLUMN booking_queue_number      smallint CONSTRAINT storefront_settings_booking_queue_ck CHECK (booking_queue_number BETWEEN 0 AND 99),
  ADD COLUMN booking_queue_category    smallint NOT NULL DEFAULT 0 CONSTRAINT storefront_settings_booking_queue_category_ck CHECK (booking_queue_category BETWEEN 0 AND 255),
  ADD COLUMN ops_alert_email           text CONSTRAINT storefront_settings_ops_alert_email_ck CHECK (position('@' in ops_alert_email) > 1),
  ADD COLUMN logo_asset_id             text REFERENCES storefront_assets (id) ON DELETE RESTRICT,
  ADD COLUMN logo_dark_asset_id        text REFERENCES storefront_assets (id) ON DELETE RESTRICT,
  ADD COLUMN logo_square_asset_id      text REFERENCES storefront_assets (id) ON DELETE RESTRICT,
  ADD COLUMN favicon_asset_id          text REFERENCES storefront_assets (id) ON DELETE RESTRICT,
  ADD COLUMN og_image_asset_id         text REFERENCES storefront_assets (id) ON DELETE RESTRICT;

COMMENT ON COLUMN storefront_settings.legal_name IS 'Registered company name for footers and e-mails (StorefrontConfig.legalName).';
COMMENT ON COLUMN storefront_settings.time_zone IS 'IANA time zone of the OTA (support hours, e-mail dates); validated against reference.time_zones.';
COMMENT ON COLUMN storefront_settings.default_market IS 'Default market (ISO 3166-1 alpha-2 point-of-sale country).';
COMMENT ON COLUMN storefront_settings.markets IS 'Markets served [{countryCode, currency, locale}].';
COMMENT ON COLUMN storefront_settings.support_details IS 'Support hours (localised), help centre URL, emergency phone (E.164).';
COMMENT ON COLUMN storefront_settings.seo IS 'SEO defaults {titleTemplate, defaultTitle, defaultDescription, robots} (localised texts by locale).';
COMMENT ON COLUMN storefront_settings.consent IS 'Cookie consent policy {regime, bannerRequired, policyVersion, categories}.';
COMMENT ON COLUMN storefront_settings.terms_version IS 'Current version of the terms, recorded in customer_consents at sign-up.';
COMMENT ON COLUMN storefront_settings.privacy_version IS 'Current version of the privacy policy, recorded in customer_consents.';
COMMENT ON COLUMN storefront_settings.airline_card_enabled_test IS 'Airline-card payments allowed in the test environment (also needs AIRLINE_CARD_ENABLED).';
COMMENT ON COLUMN storefront_settings.airline_card_enabled_live IS 'Airline-card payments allowed in the live environment (only after the M6 security review).';
COMMENT ON COLUMN storefront_settings.booking_queue_number IS 'Amadeus queue of the queuing office where every new order is placed (automatedProcess); used to find orders after a timeout.';
COMMENT ON COLUMN storefront_settings.booking_queue_category IS 'Category of booking_queue_number.';
COMMENT ON COLUMN storefront_settings.ops_alert_email IS 'Recipient of operational alerts for the OTA staff; empty = owners'' e-mails.';
COMMENT ON COLUMN storefront_settings.logo_asset_id IS 'Main logo (storefront_assets, kind logo).';
COMMENT ON COLUMN storefront_settings.logo_dark_asset_id IS 'Logo for dark backgrounds (kind logo_dark).';
COMMENT ON COLUMN storefront_settings.logo_square_asset_id IS 'Square logo for e-mails and icons (kind logo_square).';
COMMENT ON COLUMN storefront_settings.favicon_asset_id IS 'Favicon (kind favicon).';
COMMENT ON COLUMN storefront_settings.og_image_asset_id IS 'Default Open Graph image (kind og_image).';
COMMENT ON COLUMN storefront_settings.logo_url IS 'Legacy external logo URL; not used by the MVP (logo_asset_id). Contract phase later.';
COMMENT ON COLUMN storefront_settings.favicon_url IS 'Legacy external favicon URL; not used by the MVP (favicon_asset_id). Contract phase later.';
```

## 3. Tests the migration task adds

| Test | Asserts |
|---|---|
| `migrations/tenant-0002.int.test.ts`: from scratch | `0001` + `0002` on an empty schema; the catalogue matches the generated types |
| Upgrade | `0002` on a schema with baseline rows in `payments`, `checkouts`, `bookings`, `storefront_settings`; existing rows still validate |
| Airline CHECK | Inserting `provider = 'airline'` with `card_exp_month`, or with `method = 'card'`, fails; brand, BIN and last 4 succeed |
| Asset RESTRICT | Deleting an asset referenced by `storefront_settings` fails |
| Page uniqueness | Two pages with the same slug and locale fail; a published page without `published_at` fails |
| Ledger | `schema_migrations` has `0002_add_mvp_tenant_deltas` with phase `expand` and the file's checksum |

After merging: `pnpm db:codegen` and commit the regenerated tenant types in `packages/db/src/generated/`.
