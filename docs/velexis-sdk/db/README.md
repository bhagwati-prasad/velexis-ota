# Velexis OTA platform: multi-tenant PostgreSQL 16 database

Velexis is a multi-tenant OTA SaaS. Each OTA (tenant) gets **its own PostgreSQL schema `tenant_<key>`** that holds its own copy of every table with OTA-specific data. Two shared schemas complete the design: `platform` (the control plane) and `reference` (read-only travel reference data).

| File | Content |
|---|---|
| `platform.sql` | `CREATE SCHEMA platform` and its 16 control-plane tables (accounts, tenants, memberships, billing, API keys and hosting-key grants, encrypted supplier and PSP credentials, the migration ledger, jobs, audit). Contains **no end-customer PII**. |
| `reference.sql` | `CREATE SCHEMA reference` and its 7 tables (countries, currencies, time_zones, cities, airports, airlines, aircraft). Natural keys and prefix-search indexes. |
| `tenant.sql` | The tenant migration set (baseline `0001`), 42 tables. It holds only unqualified `CREATE TABLE / INDEX / ALTER TABLE ... ADD CONSTRAINT` statements and runs after `SET LOCAL search_path TO tenant_<key>, reference`. |
| `er/er-overview.mmd` | The tenancy model: one tenant row owns one schema, and tenant data references platform and reference rows by value only. |
| `er/er-platform.mmd`, `er/er-reference.mmd`, `er/er-tenant.mmd` | One ER diagram per schema: every table, its PK/FK/UK columns and its key attributes, with one relationship line per foreign key labelled `fk_column (on delete rule)`. `check_db.py` renders them to `.svg`. |
| `dictionary.json` | Every table and every column, with a description plus `[type, nullability, PK/UNIQUE, FK -> target ON DELETE ...]`. |
| `gen_docs.py` | Builds a scratch database from the three SQL files and generates `dictionary.json` and the three schema diagrams. Descriptions come from the SQL comments: the comment above `CREATE TABLE` describes the table, the trailing comment describes each column, and a leading `* ` puts the column in the ER diagram. The structure comes from introspecting the database, so the docs always match the DDL. |
| `check_db.py` | The validator. It provisions two tenant schemas, compares them, checks diagrams against the real tables and FKs, checks dictionary coverage and renders the diagrams. |

Regenerate the docs and validate with `python3 -I gen_docs.py && python3 -I check_db.py`. The expected result is `ERRORS: 0 / WARNINGS: 0`.

## 1. Why schema-per-tenant

| Option | Isolation | Ops cost | Why it was or was not chosen |
|---|---|---|---|
| Shared tables + `tenant_id` (+ RLS) | Logical; one missing predicate leaks data | Lowest | One migration and one pool. But every query and index must carry `tenant_id`, per-tenant export and deletion become `DELETE ... WHERE` across 40-plus tables, and a noisy tenant bloats shared indexes. |
| **Schema per tenant** (chosen) | Namespace per OTA. Optional DB role per tenant | Medium | Connection pools are shared per cluster. Each OTA's data can be dumped (`pg_dump -n`), restored, moved or erased (`DROP SCHEMA ... CASCADE`) on its own. Indexes and statistics are per tenant. The tables carry no `tenant_id`. A wrong tenant needs a wrong `search_path`, which one place in the code controls. |
| Database per tenant | Strongest | Highest | Needs one pool per database, cross-database platform joins are impossible, and each database adds catalog and autovacuum cost. Kept as the escape hatch for very large tenants, which go to a dedicated cluster through `platform.tenants.cluster`. |

The **schema is the isolation boundary**. Tenant tables have no `tenant_id`, and tenant rows reference platform and reference rows **by value** (`stf_…` staff ids, `sc_…` supplier connection id, IATA codes, ISO currency codes). Nothing crosses schemas through a foreign key, so a schema can be dumped, restored or moved on its own.

## 2. What lives where

| Schema | Tables | Notes |
|---|---|---|
| `platform` | `accounts`, `account_sessions`, `tenants`, `tenant_domains`, `tenant_memberships`, `tenant_invitations`, `plans`, `subscriptions`, `invoices`, `api_keys`, `api_key_tenant_grants`, `supplier_connections`, `payment_provider_connections`, `tenant_schema_migrations`, `provisioning_jobs`, `platform_audit_log` | Holds portal users (OTA owners and staff), never travellers. A staff member's id is the `tenant_memberships.id` (`stf_…`), the subject of staff tokens. Secrets are stored only as envelope-encrypted `bytea` together with the `encryption_key_id`. Billing rows use `ON DELETE RESTRICT`. |
| `reference` | `countries`, `currencies`, `time_zones`, `cities`, `airports`, `airlines`, `aircraft` | Loaded by platform jobs and identical on every cluster. Autocomplete without pg_trgm uses `WHERE lower(name) LIKE lower($1) \|\| '%'` on `lower(name) text_pattern_ops` btree indexes (verified with `EXPLAIN`: a bitmap index scan on both name indexes), plus exact code lookups on the PKs. Time zones convert Amadeus local times to UTC for `first_departure_at`, `last_arrival_at` and `ticketing_deadline_at`. |
| `tenant_<key>` | Identity: `customers`, `customer_identities`, `customer_sessions`, `customer_password_resets`, `customer_preferences`, `customer_consents`, `customer_data_exports`, `saved_travelers`, `saved_traveler_documents`. Shopping: `flight_searches`, `flight_offers`, `offer_upsells`, `priced_offers`. Checkout: `checkouts`, `checkout_travelers`, `checkout_contacts`, `checkout_ancillaries`, `checkout_remarks`. Money: `payments`, `payment_events`, `refunds`. Orders: `bookings`, `booking_associated_records`, `booking_travelers`, `booking_contacts`, `booking_segments`, `booking_ancillaries`, `booking_remarks`, `booking_tickets`, `booking_documents`, `booking_events`, `booking_access_tokens`. Ops: `supplier_requests`, `queue_snapshots`, `staff_actions`, `notifications`, `notification_templates`, `idempotency_keys`. Configuration: `markup_rules`, `fee_rules`, `storefront_settings`. Housekeeping: `schema_migrations` | 42 tables: all 37 tables from brief §5; the three tables the API added in `x-new-tenant-tables` (`customer_consents`, the append-only consent log behind marketing consent and terms acceptance; `customer_data_exports`, GDPR export jobs `dex_`; `checkout_remarks`, special requests `crm_` copied to Amadeus general remarks and `booking_remarks`); `booking_associated_records` (every Amadeus `associatedRecords` entry, including other-airline locators used by the by-reference lookup); and `schema_migrations` (the per-schema migration ledger). Every table named in an operation's `x-tenant-tables` exists here. |

### 2.1 Tenant schema conventions

- **IDs** are `text` primary keys: a type prefix followed by a ULID (time-sortable, so `(created_at, id)` cursors are stable). Each table has `CHECK (id LIKE 'bkg\_%')`, so an id of the wrong type cannot be stored. The 80 random bits of each ULID come fresh from a CSPRNG for every id; monotonic ULID generators, which increment the random part within one millisecond and make neighbouring ids predictable, are forbidden. This matters because `srch_`, `off_`, `prc_`, `chk_` and `pay_` ids are capability ids that grant guest access on their own: the secret is the 80 random bits (the 48-bit timestamp is guessable), and lookups by id are rate-limited per IP and key. Prefixes: `cus_` customers, `cid_` identities, `ses_` sessions, `pwr_` password resets, `cpf_` preferences, `ccn_` consent events, `dex_` data exports, `trv_` saved travellers, `tdc_` traveller documents, `srch_` searches, `off_` offers, `ups_` upsells, `prc_` priced offers, `chk_` checkouts, `ctr_`/`cco_`/`can_`/`crm_` checkout travellers/contacts/ancillaries/remarks, `pay_` payments, `pev_` payment events, `rfd_` refunds, `bkg_` bookings, `bar_` associated records, `btr_`/`bco_`/`seg_`/`anc_`/`rmk_` booking children, `tkt_` tickets, `doc_` documents, `evt_` booking events, `bat_` booking access tokens, `sreq_` supplier requests, `qsn_` queue snapshots, `ntt_` templates, `ntf_` notifications, `sact_` staff actions, `idk_` idempotency keys, `mkr_` markup rules, `fee_` fee rules, `sfs_default` (single storefront settings row). Staff are referenced by value as `stf_`.
- **Timestamps**: every tenant table has `created_at` and `updated_at timestamptz` (the application maintains `updated_at`; on append-only tables it equals `created_at`). Amadeus local times are kept as `timestamp` (`departure_local`) next to the UTC instant (`departure_at`).
- **Optimistic locking**: aggregate roots carry `version int` (`customers`, `customer_data_exports`, `saved_travelers`, `saved_traveler_documents`, `customer_preferences`, `checkouts`, `payments`, `refunds`, `bookings`, `markup_rules`, `fee_rules`, `notification_templates`, `storefront_settings`). A change to a child row (for example a checkout traveller) bumps the root with `UPDATE ... SET version = version + 1 WHERE id = $1 AND version = $2`. Zero rows updated means `VERSION_CONFLICT` / `PRECONDITION_FAILED`. The API exposes `version` as the ETag for `If-Match`.
- **Statuses** are `text` with a `CHECK` list rather than PG enums, so adding a value is an expand-only migration (drop and re-add the CHECK).
- **Money** is `numeric(12,2)` plus a `char(3)` ISO currency. *Selling* amounts are what the customer pays. *Net* amounts are the Amadeus cost and are visible in console scope only. CHECKs keep totals consistent: `flight_offers.selling_total = net_total + markup_amount`, `priced_offers.selling_total = net + markup + fees`, `checkouts.total_amount = offer + ancillaries + fees`, and `payments` requires refunded ≤ captured ≤ amount.
- **Supplier payloads are kept verbatim**: `flight_offers.payload` (AmadeusFlightOffer), `priced_offers.response` (data, bookingRequirements, included credit-card-fees/bags/other-services/detailed-fare-rules, dictionaries, warnings), `bookings.order_snapshot` (flight-order `data` after the redaction rule of §8), `queue_snapshots.response`, and `supplier_requests.request_body/response_body` with a `redacted` flag. Structured columns are extracted next to them for filtering and sorting.
- **Environment**: every supplier- or payment-bound aggregate (`flight_searches`, `flight_offers`, `priced_offers`, `checkouts`, `payments`, `bookings`, `supplier_requests`, `queue_snapshots`) carries `environment test|live`, taken from the API key. Test data uses the tenant's Amadeus test connection and is never listed with live data: console indexes lead with `environment`. Customers and identities are shared by both modes.
- **ON DELETE**:
  - `CASCADE` for children of an aggregate (checkout → travellers, contacts, ancillaries and remarks; booking → travellers, segments, tickets and so on; customer → identities, sessions, consents, data exports and saved travellers; search → offers → upsells and priced offers).
  - `SET NULL` for optional links whose history must survive (booking → customer, booking → markup rule, notification → booking, supplier request → booking, priced offer → parent priced offer).
  - `RESTRICT` for financial records (`payments.booking_id`, `refunds.*`) and for in-flight dependencies: `checkouts.priced_offer_id` (the priced offer being bought) and `checkouts.base_priced_offer_id` (the priced offer the checkout was opened with, whose ancillary catalogue `checkout.setAncillaries` uses) block purging an offer that backs a checkout, and the purge job skips such rows.
- **Status machines**:
  - checkout: `open → payment_pending → completed | expired | abandoned`
  - payment: `requires_payment_method → requires_action → processing → authorized → captured → partially_refunded → refunded`, with `authorized → canceled` and `→ failed`
  - booking: `pending → confirmed → ticketed | partially_ticketed → cancelled`, with `pending → failed`
  - booking ticketing (`bookings.ticketing_status`, the API's `IssuanceStatus`): `pending → in_progress → issued | partially_issued | failed`; `failed → in_progress` again while `ticketing_next_attempt_at` is before the deadline (`ticketing_attempts`, `ticketing_last_attempt_at`, `ticketing_error_code` record each try); `manual_review` when staff issue; `not_applicable` for failed bookings (CHECK) or cancellation before issuance. A `ticketed` booking must be `issued` (CHECK).
  - data export: `queued → processing → ready → expired`, with `→ failed`; one queued/processing export per customer (partial unique index)
  - refund: `pending → processing → succeeded | failed`
  - notification: `pending → sending → sent → delivered | bounced`, with `→ failed`
  - Transitions are written together with an append-only event in the same transaction (`booking_events`, `payment_events`).

## 3. Provisioning on sign-up

The portal account (`platform.accounts`, status `pending_verification → active`) creates an OTA. The sequence is idempotent and resumable. Each step is recorded in `provisioning_jobs.steps`.

1. **Request (one platform transaction, `Idempotency-Key` honoured)**:
   - Validate the `key` (regex, reserved words, `UNIQUE`). A deleted tenant keeps its row, so keys are never reused.
   - Choose the `cluster`: the least-loaded cluster in the requested `region`.
   - `INSERT` the following rows:
     - `tenants`: `status = 'provisioning'`, `schema_name` generated as `'tenant_' \|\| key`, `plan_code`, default currency and locale.
     - `tenant_memberships`: the founder as `owner`, which creates the `stf_` id.
     - `subscriptions` (`trialing`).
     - `tenant_domains`: `<key>.velexis.app`, `subdomain`, primary.
     - `provisioning_jobs`: `kind = 'provision'`, `status = 'queued'`. A partial unique index allows only one active job per tenant and kind.
     - `platform_audit_log`: `tenant.created`.
   - `COMMIT`, then answer `202` with the tenant in `provisioning`.
2. **Lease**: a worker runs `UPDATE provisioning_jobs SET status='running', locked_by=$w, locked_until=now()+'5 min', attempt=attempt+1, started_at=coalesce(started_at, now()) WHERE id = (SELECT id FROM provisioning_jobs WHERE status='queued' AND scheduled_at <= now() ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. A crashed worker's lease expires and another worker resumes the job.
3. **`create_schema` + `run_migrations` + `seed_defaults`**: one transaction on the tenant's cluster, so DDL and seed data succeed together or not at all.
   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   SELECT pg_advisory_xact_lock(hashtext('tenant:' || $schema));
   CREATE SCHEMA IF NOT EXISTS tenant_acme AUTHORIZATION velexis_migrator;
   SELECT set_config('search_path', 'tenant_acme, reference', true);   -- = SET LOCAL
   -- for each migration file not yet in schema_migrations (0001_baseline = tenant.sql, 0002_..., ...):
   --   execute file; INSERT INTO schema_migrations (id, description, checksum, phase) VALUES (...);
   INSERT INTO storefront_settings (brand_name, default_currency, default_locale, ...) VALUES ($name, $cur, $loc, ...)
     ON CONFLICT (id) DO NOTHING;
   INSERT INTO markup_rules (id, name, calculation, percentage, is_default, priority) VALUES ('mkr_…', 'Default', 'percentage', $planDefault, true, 1000)
     ON CONFLICT DO NOTHING;
   INSERT INTO notification_templates (...) SELECT ... FROM the platform template catalogue   -- auth.verify_email, auth.password_reset,
     ON CONFLICT (key, channel, locale) DO NOTHING;                                        -- booking.confirmed, booking.ticketed, booking.cancelled, ...
   -- optional: CREATE ROLE tenant_acme_rw ... GRANTs (section 7)
   COMMIT;
   ```
   Re-running this step is harmless: it uses `IF NOT EXISTS`, skips migrations already in `schema_migrations` (after verifying their checksums), and seeds with `ON CONFLICT DO NOTHING`.
4. **`record_migrations`** (platform cluster): upsert `platform.tenant_schema_migrations` rows (`status = 'applied'`) and set `tenants.schema_version`. The tenant's own `schema_migrations` is the source of truth; the platform ledger is a mirror that the runner reconciles.
5. **`issue_api_keys`**:
   - Create `pk_test_…` and `sk_test_…`. Store `prefix`, `last4` and `key_hash = HMAC-SHA-256(pepper, key)` in `platform.api_keys`.
   - The raw values are KMS-encrypted into `provisioning_jobs.result` for a single **reveal-once** retrieval by the owner. That ciphertext is erased on first reveal or after 24 h.
   - Live keys are issued only after a `live` Amadeus `supplier_connections` row is `active` and the plan allows live mode. Re-running the step skips it if test keys already exist.
6. **`activate`**:
   - `UPDATE tenants SET status='active', activated_at=now(), version=version+1 WHERE id=$1 AND status='provisioning'`.
   - Write the audit row, publish a Redis cache invalidation and send the welcome e-mail.
   - Set the job to `succeeded`.

**Failure handling**:
- A transient error (lock timeout, connection loss, KMS throttling) sets the job back to `queued` with `scheduled_at = now() + 30s·2^attempt` and stores `error`.
- After `max_attempts`, or on a non-retryable error (for example an existing schema with foreign content, or a checksum mismatch), the job and the tenant become `failed`, the platform team is alerted, and the portal shows "setup failed, retry".
- A failed tenant's schema is dropped only by an explicit `delete` job after review. An activated tenant's schema is never dropped automatically.
- Because the DDL is transactional, a crash never leaves a half-built schema. The only possible orphan is an empty `CREATE SCHEMA` without migrations, and the next attempt completes it.

## 4. Tenant migration runner

- **Sources**:
  - `migrations/platform/*.sql` and `migrations/reference/*.sql`: schema-qualified, applied once per cluster.
  - `migrations/tenant/NNNN_name.sql`: unqualified like `tenant.sql`, applied once per tenant schema. `tenant.sql` is the consolidated baseline `0001_baseline`.
- **Two ledgers**:
  - `tenant_<key>.schema_migrations` (`id` = version, checksum, phase, status) is authoritative and travels with the schema in dumps and moves.
  - `platform.tenant_schema_migrations (tenant_id, version)` plus `tenants.schema_version` give a fleet-wide view, for example `SELECT ... WHERE version = $v AND status <> 'applied'`.
- **Fan-out**:
  - On deploy, the release job selects target tenants: `SELECT id, key, schema_name, cluster FROM platform.tenants WHERE status IN ('active','suspended','provisioning') AND coalesce(schema_version,'') < $target ORDER BY cluster, key`.
  - Each schema is migrated in its own transaction, with bounded concurrency: by default 4 schemas at a time per cluster and 16 overall (p-limit / BullMQ group concurrency). This keeps lock pressure and WAL bursts bounded and avoids exhausting `max_locks_per_transaction`, which one giant all-schemas transaction would do.
  - Per schema: `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10min'; pg_advisory_xact_lock(hashtext(schema)); set_config('search_path', schema || ', reference', true)`, verify the checksums of applied files, apply the pending ones, insert ledger rows, `COMMIT`. Then mirror the result to the platform cluster.
- **Rollout**: canary on internal and demo tenants first, then 5 %, then everyone.
  - A failed schema is recorded as `failed` with its error and retried. It does not stop other tenants.
  - The rollout halts automatically above a failure-rate threshold.
  - The application must work with schema versions N-1 and N while a rollout is in progress.
- **Expand / migrate / contract** (`phase` column in both ledgers):
  - *Expand*: backward-compatible changes. Add a nullable column or a new table. Extend a CHECK list by adding the new one `NOT VALID` and then running `VALIDATE CONSTRAINT`. Indexes on large tables use `CREATE INDEX CONCURRENTLY`, in migrations flagged `-- velexis:no-transaction` that the runner executes outside a transaction and then records.
  - *Migrate*: deploy code that writes both shapes, and backfill per tenant in batches through a background job.
  - *Contract*: in a later release, once every tenant reports the version and the backfill, drop the old columns and constraints.
  - Destructive changes never ship in the same release as the code that stops using them.
- **New tenants** run the same list from `0001`, so every schema is identical. `check_db.py` asserts this with two provisioned schemas. A nightly drift check hashes the normalised catalog of each schema (`information_schema.columns`, `pg_indexes`, constraints), compares it with a golden schema at the same version, and flags drift.

## 5. Request routing in NestJS

1. **Resolve the tenant** in a global middleware:
   - **API key**: `X-Api-Key` → `prefix` lookup → Redis `apikey:<prefix>` (falls back to `platform.api_keys`) → constant-time compare of `HMAC(pepper, key)` with `key_hash`. Then check `revoked_at`/`expires_at`, `allowed_origins` against `Origin` (publishable keys), and `kind` against the operation's `x-scope`. This yields `{tenantId, environment, keyKind, scopes}`. Key kinds: publishable `pk_` (customer scope only), secret `sk_` (customer scope on dual-scope operations; console scope with a staff token unless the key is limited to `storefront`, or key-only console access when `scopes` contain `console:automation` plus explicit permissions and the call sends `X-Velexis-Scope: console`) and hosting `hk_` (`tenant_id` NULL, `owner_account_id` set; the tenant comes from `X-Velexis-Host`, which must be a verified `tenant_domains` entry of a tenant listed in `api_key_tenant_grants`).
   - **Host**: never used on its own. Every operation's `security` requires `X-Api-Key`, and the environment (test/live, and with it the Amadeus and PSP connection) comes only from the key, so `platform.tenant_domains` has no environment column. A verified custom API host (`tenant_domains.purpose = 'api'`) is resolved to its tenant and must match the key's tenant (otherwise `401`), which stops a key of OTA A from being replayed on OTA B's host. A request without a key is rejected before any tenant lookup.
2. **Load the tenant** from Redis `tenant:<id>` (60 s TTL, invalidated through pub/sub on change; source `platform.tenants`). Only `status = 'active'` is served; anything else returns `TENANT_SUSPENDED`. The result `{id, key, schemaName, cluster, environment}` goes into AsyncLocalStorage (`nestjs-cls`). Customer and staff JWTs carry a `tid` claim that must equal the resolved tenant, so a token from OTA A is rejected at OTA B. Staff tokens also carry `stf_` and the roles from `tenant_memberships`.
3. **Run the use case in a tenant transaction**. One `pg.Pool` exists per **cluster**, not per tenant, so connections are shared by all schemas of the cluster.
   ```ts
   async run<T>(fn: (tx) => Promise<T>) {
     const t = cls.get('tenant');                                // from platform, never from user input
     assert(/^tenant_[a-z][a-z0-9_]{1,39}$/.test(t.schemaName));
     return pools[t.cluster].tx(async (tx) => {
       await tx.query("SELECT set_config('search_path', $1, true)", [`${t.schemaName}, reference`]); // = SET LOCAL
       if (perTenantRoles) await tx.query(`SET LOCAL ROLE ${quoteIdent(t.schemaName + '_rw')}`);
       await tx.query("SELECT set_config('statement_timeout', '15s', true)");
       return fn(tx);
     });
   }
   ```
   `set_config(..., true)` is the parameterised form of `SET LOCAL`, so no identifier is ever concatenated into SQL. Platform queries are always schema-qualified (`platform.tenants`) and run in separate, short transactions.
4. **Guarding against `search_path` leaks** with pooled connections:
   - Session-level `SET search_path` is forbidden. A CI lint step greps for `SET search_path` / `set_config(..., false)` outside the DB module.
   - `SET LOCAL` is discarded at `COMMIT` or `ROLLBACK`, so a connection returned to the pool carries no tenant.
   - The role default is `ALTER ROLE velexis_app SET search_path = pg_catalog`. Any unqualified query outside a tenant transaction then fails loudly (`relation "bookings" does not exist`) instead of silently reaching some schema.
   - In dev and test, the pool's `release` hook asserts `current_setting('search_path') = 'pg_catalog'`.
   - **PgBouncer transaction mode** is compatible because all tenant state is transaction-scoped (`SET LOCAL`, `SET LOCAL ROLE`, `set_config(...,true)`). Do not rely on session state, advisory session locks or `LISTEN` through it.
   - Named prepared statements need PgBouncer ≥ 1.21 with `max_prepared_statements`, or should be disabled. PostgreSQL invalidates cached plans when `search_path` changes, so plans never cross tenants.
   - An integration test runs two tenants concurrently through a pool of size 1 and asserts that each sees only its own rows.
5. **Other per-tenant state**: Redis keys are namespaced `t:<tenantId>:<env>:…` (offer caches, rate limits, Amadeus access tokens). Object-storage keys are prefixed `tenant_<key>/`.

## 6. Background jobs per tenant

A platform scheduler (BullMQ on Redis) enqueues one job per **active tenant** and job type (`SELECT id, key, cluster FROM platform.tenants WHERE status='active'`). Jobs carry `tenantId`. Workers re-check the tenant status and run through the same `run()` wrapper. Concurrency is limited per tenant and globally, so one large OTA cannot starve the others.

| Job | Schedule | Tables / index used |
|---|---|---|
| Offer cache purge | 15 min | `flight_offers_expires_idx`, `flight_searches_expires_idx`, `offer_upsells_expires_idx`, `priced_offers_expires_idx`. Deletes expired searches (CASCADE to offers, upsells and priced offers) `WHERE NOT EXISTS` a checkout whose `priced_offer_id` **or** `base_priced_offer_id` is one of their priced offers (`checkouts_priced_offer_idx`, `checkouts_base_priced_offer_idx`). Child priced offers lose their `parent_priced_offer_id` (SET NULL). The two RESTRICT FKs are the safety net. |
| Checkout expiry | 1 min | `checkouts_expiry_idx` (`open/payment_pending`). Sets `expired` and voids authorised payments. |
| Booking sync | 10 min, oldest first | `bookings_sync_idx`. Flight Order Management `GET` (`include=bags`), then updates `order_snapshot`, segments, tickets and `last_synced_at`, and writes `booking_events` (schedule changes). |
| Ticketing deadline monitor and issuance retry | 5 min | `bookings_ticketing_retry_idx` (`ticketing_status` pending/failed with `ticketing_next_attempt_at` due) and `bookings_ticketing_status_idx` (`environment, ticketing_status, ticketing_deadline_at`, also the console work list). Calls Flight Order Issue per `storefront_settings.ticketing_policy`, bumps `ticketing_attempts`, sets `ticketing_last_attempt_at` / `ticketing_next_attempt_at` / `ticketing_error_code`, alerts staff, or lets `DELAY_TO_CANCEL` happen after the deadline. |
| Notification outbox | Event-driven, plus a 1 min sweep | `notifications_outbox_idx` with `FOR UPDATE SKIP LOCKED`. After commit, the writer enqueues `notify:<tenantId>`, so tenants are not polled blindly. The worker decrypts `secret_payload_ciphertext` only to render, and erases it (`secrets_purged_at`) in the same update that moves the row out of `pending`/`sending`; `notifications_secret_purge_ck` rejects any final status that still holds it. |
| Customer data exports | Event-driven, plus a 5 min sweep | `customer_data_exports_queue_idx` (queued jobs), worker writes the ZIP, sets `ready`/`expires_at` and queues `data_export_ready`; `customer_data_exports_expires_idx` deletes files after 7 days (status `expired`, `delivery_email` cleared). |
| Queue poller | Per `supplier_connections.monitored_queues` | Amadeus Queue List → `queue_snapshots`. |
| Retention purges | Daily | `supplier_requests_created_idx` (90 days, per environment), `queue_snapshots_fetched_idx` (30 days), `idempotency_keys_expires_idx` (24 h), `customer_sessions_expires_idx`, `customer_password_resets_expires_idx`, `booking_access_tokens_expires_idx`. |
| Documents and payment reconciliation | On events | `booking_documents`, `payments` / `payment_events` (PSP webhooks are de-duplicated by `provider_event_id`). |

## 7. Backups, restore, export and deletion per tenant

- **Disaster recovery (cluster level)**: continuous WAL archiving plus nightly base backups (pgBackRest) give point-in-time recovery of the whole cluster. Retention is 35 days.
- **Per-tenant logical backup**: a nightly `pg_dump --format=custom --schema=tenant_acme --no-owner --file=tenant_acme-$(date +%F).dump velexis`. The dump is encrypted with the tenant's data key and stored in the tenant's region.
- **Restore one tenant** without touching the others:
  1. Suspend the tenant (`status = 'suspended'`, cache invalidated).
  2. `pg_restore --schema=tenant_acme` into a scratch database, `ALTER SCHEMA tenant_acme RENAME TO tenant_acme_restore` there, dump it again and restore it beside the live schema.
  3. Bring it to the current migration version with the runner.
  4. Either swap in one transaction (`ALTER SCHEMA tenant_acme RENAME TO tenant_acme_old; ALTER SCHEMA tenant_acme_restore RENAME TO tenant_acme;`) or copy selected rows back.
  5. Resume the tenant.
  - For point-in-time recovery of one tenant, restore the cluster PITR into a temporary instance and `pg_dump -n tenant_acme` from it.
- **Export** (OTA leaves, or data portability): a `provisioning_jobs` row with `kind='export'` produces:
  - the `pg_dump -n tenant_acme` archive;
  - per-table CSV/JSON (`COPY ... TO STDOUT`), with ciphertext columns decrypted only if the owner requests it;
  - the tenant's platform rows: tenant, domains, memberships, API key metadata without hashes, subscriptions, invoices.
  - A signed URL is returned in `result`.
- **Deletion**: a `kind='delete'` job sets `status='deprovisioning'`, revokes API keys and domains, and keeps a final export for the contractual period. It then runs `DROP SCHEMA tenant_acme CASCADE`, one statement that erases all of the OTA's end-customer data, and drops the per-tenant role.
  - Platform rows that CASCADE (keys, domains, memberships, connections, ledger, jobs) are deleted with it.
  - `subscriptions`/`invoices` (RESTRICT) and `platform_audit_log` are kept.
  - The `tenants` row stays as `deleted`, so the key is never reused.
  - Old backups age out, and destroying the tenant's data key crypto-shreds the encrypted columns in them.
- **End-customer erasure inside a tenant** (`account.delete`):
  - Immediately, in one transaction: an optional `customer_data_exports` job (its `delivery_email` captured first), all `customer_sessions` revoked (`revoke_reason = 'account_deleted'`), the identities disabled (`customer_identities.disabled_at`, `provider_subject` replaced by the placeholder), a `customer_consents` withdrawal event, `customers.status = 'deleted'`, `deleted_at` set and `email` replaced by `'<HMAC-SHA-256 hex of the address>@deleted.invalid'`. That value passes the e-mail CHECK, `customers_deleted_ck` enforces it, and because subjects are unique only among enabled identities (`customer_identities_subject_uq ... WHERE disabled_at IS NULL`) the address can register again at once.
  - The erasure job (within 30 days) hard-deletes saved travellers, documents, preferences, sessions and reset tokens and anonymises `customers`. `DELETE FROM customers` would cascade to identities, sessions, password resets, preferences, consents, exports and saved travellers. Bookings keep `customer_id = NULL`, and traveller PII in `booking_*` is anonymised once the legal retention period is over.

## 8. Security

- **Database roles**:
  - `velexis_migrator` owns the schemas and runs DDL.
  - `velexis_app` has DML on tenant tables, `SELECT` on `reference`, and DML on `platform`. `CREATE` on `public` is revoked.
  - **Optional per-tenant role** (default on for enterprise plans): `CREATE ROLE tenant_acme_rw NOLOGIN`, `GRANT USAGE` on `tenant_acme` and `reference`, DML on `tenant_acme` tables, `ALTER DEFAULT PRIVILEGES` for future tables. `velexis_app` is a `NOINHERIT` member of every tenant role and does `SET LOCAL ROLE tenant_acme_rw` per request. Even a bug that qualifies another schema then gets `permission denied`. The cost is one role per tenant and grants re-applied by migrations.
- **Secrets** (Amadeus client secret, PSP secrets and webhook secrets, MFA secrets) use envelope encryption: an AES-256-GCM data key per record, wrapped by a regional KMS key, with the `encryption_key_id` stored alongside. A `rotate_secrets` job re-wraps them. They are decrypted only inside the supplier and payment gateway modules. Amadeus OAuth access tokens live only in Redis, encrypted, with their TTL.
- **Identity documents and resident numbers**: `saved_traveler_documents.number_ciphertext`, `checkout_travelers` / `booking_travelers.documents_ciphertext`, and `discount_eligibility_ciphertext` on `saved_travelers`, `checkout_travelers` and `booking_travelers` (Amadeus `discountEligibility` with `cardNumber` / `certificateNumber`; no clear jsonb copy exists) are encrypted by the application with a **per-tenant data key**. Only `last4`, expiry and countries stay in clear, for display and validation.
- **Redaction rule for jsonb copies**: every jsonb copy of an API or supplier payload goes through one shared redactor before it is written. It masks `documents[].number` and `discountEligibility[].cardNumber` / `certificateNumber` to their last 4 characters and `creditCard.number` to its last 4 digits. It drops `securityCode`, `birthPlace`, `issuanceLocation` and every token value. This covers `bookings.order_snapshot` (including the `updateSnapshot` of console.bookings.retrieve), `booking_events.data` diffs, `staff_actions.before/after` (console.bookings.patch on travellers' documents or `formOfPayments`), `idempotency_keys.response_body`, `supplier_requests` bodies, `priced_offers.amadeus_request`, `payment_events.payload` and `notifications.payload`. Each of these column comments states the rule. Unmasked values exist only in `*_ciphertext` columns.
- **Cards are never stored** (PCI scope stays with the PSP): payments keep only the PSP id, brand, BIN (needed for Flight Offers Price credit-card fees) and last4. Card data in Amadeus `formOfPayments` is passed in memory only. `bookings.form_of_payments`, `order_snapshot`, `staff_actions`, `booking_events` and `supplier_requests` hold redacted copies (`redacted = true`). A replayed raw create-order response is kept only in `idempotency_keys.response_ciphertext`, and it holds no card data because Amadeus masks card numbers in its responses.
- **Hashed tokens**: refresh tokens, booking access tokens, password reset and e-mail verification tokens, invitations and API keys are stored as SHA-256/HMAC hashes. Refresh tokens rotate within a `family_id`, and reuse of a rotated token revokes the whole family. The family's absolute lifetime is `customer_sessions.family_expires_at` (30 days with `remember_me`, 12 hours without), and a CHECK keeps each `expires_at` within it.
- **Raw tokens that must live for a while** are encrypted and purged:
  - *Idempotent replays*: `checkout.complete` (guest `bookingToken`), `bookings.lookup` (same token on retry), `console.bookings.create` and the raw `console.amadeus.*` order calls store the verbatim response only in `idempotency_keys.response_ciphertext` (with `encryption_key_id`, CHECK). `response_body` keeps the redacted copy. Both are deleted with the row after 24 h. `auth.signUp`, `auth.signIn`, `auth.refresh` and `console.auth.signIn` replay session tokens from an encrypted Redis entry (5 min / 60 s) or from `response_ciphertext`, never from clear jsonb.
  - *E-mail outbox*: verification links (`auth.signUp`, `account.update`, `auth.resendVerification`), reset links (`auth.requestPasswordReset`) and guest booking tokens (for example in the confirmation that `console.bookings.create` sends) go into `notifications.secret_payload_ciphertext`, never into `payload`. The worker erases the ciphertext when the message reaches a final status, and `notifications_secret_purge_ck` enforces this.
- **Capability ids**: guest access to searches, offers, priced offers, checkouts and payments by id alone relies on the CSPRNG-generated, non-monotonic ULID random part (80 bits, see §2.1), not on the timestamp.
- **Documents** (`booking_documents`) live in a private bucket with SSE-KMS and are served through short-lived signed URLs; `content_hash` guards integrity.
- **Audit**: `platform_audit_log` records control-plane actions and `staff_actions` records console actions, both append-only with before/after state. Every `staff_actions` row has an actor (`actor_type` staff / api_key / system, `actor_id` stf_ / key_ by value), which maps to `ConsoleStaffAction.actor`. Secret-key calls without a staff token are recorded as `api_key` with the `key_` id. Failed or denied staff sign-ins carry only `staff_email`. `staff_actions_actor_ck` enforces these combinations.

## 9. Scaling notes

- PostgreSQL has **no hard schema limit**. The real limits are:
  - **Catalog size**: one tenant is 42 tables, 192 indexes (including PK and unique indexes), 42 TOAST tables and 42 TOAST indexes, about 320 relations. 1,000 tenants is about 320k `pg_class` rows; 10,000 is about 3.2M.
  - **Per-backend relcache/catcache memory**: it grows with the number of distinct schemas a connection touches. Keep pools moderate and recycle server connections (PgBouncer `server_lifetime`).
  - **Autovacuum**: workers scan every relation. Tune `autovacuum_naptime` and `autovacuum_max_workers`.
  - **Files**: each relation has 1 to 3 files.
  - **Duration**: whole-database `pg_dump` and migration fan-out time grow linearly with the number of tenants.
- **Guideline**: about 2,000 to 5,000 tenants per cluster, or less when storage or IOPS are the bottleneck.
- **Sharding by `platform.tenants.cluster`**:
  - New tenants are placed on the least-loaded cluster in their region. Every cluster carries `reference`; `platform` lives on the control cluster.
  - To **move a tenant**: create the empty schema on the target with the runner. Use `CREATE PUBLICATION ... FOR TABLES IN SCHEMA tenant_acme` (PG 15+) and a subscription to replicate, wait for catch-up, then pause writes briefly by suspending the tenant. Switch `tenants.cluster`, invalidate the cache, resume, and drop the old schema later. Small tenants can simply be moved with `pg_dump -n | pg_restore`.
  - Very large or noisy tenants go to a dedicated cluster, which runs the same code with a different `cluster` value.
- **Hot append-only tables** (`supplier_requests`, `booking_events`, `flight_offers`) are purged by time. If one tenant outgrows that, a later migration partitions them by month.
- Console reporting can use per-cluster read replicas, with the same `search_path` routing on a replica pool.

## 10. How the API areas use the tables

| Area (paths) | Tenant tables (`x-tenant-tables`) | Platform / reference |
|---|---|---|
| **B1 Storefront, identity, account, reference** (`/v1/storefront`, `/v1/auth`, `/v1/account`, `/v1/reference`) | `storefront_settings` (branding, locales, currencies, policies). Sign-up and sign-in: `customers` (`pending_email`, `date_of_birth`, `terms_accepted_version`, `marketing_consent_source`, `last_sign_in_at`), `customer_identities`, `customer_consents` (terms, privacy and marketing events, source `sign_up` / `account` / `unsubscribe_link` / `console`, hashed IP), `customer_sessions` (refresh rotation and reuse detection by `family_id`, `remember_me`, `family_expires_at`, `ip_country`), `customer_password_resets`, e-mail verification (`customer_identities.verification_token_hash`, also for `pending_email`). Account: `customer_preferences`, `saved_travelers` (`last_used_at`), `saved_traveler_documents`, `customer_data_exports` (`account.dataExports.*`, `account.delete`). Mail: `notifications` (secrets only in `secret_payload_ciphertext`), `notification_templates`. Every POST: `idempotency_keys` | API key resolution (`api_keys`, `tenants`; `tenant_domains` only to check a custom API host against the key's tenant). `/v1/reference/*` reads `reference.airports/cities/airlines/countries/currencies/aircraft/time_zones` through the search path, using `lower(name) LIKE 'q%'` |
| **B2 Shopping** (`/v1/flight-searches`, `/v1/flight-offers`, `/v1/flight-availabilities`, `/v1/priced-offers`) | `flight_searches` (criteria, `mode simple/advanced`, `kind offers/availability`, `result_count`, `expires_at`). `flight_offers`: `flights.listResults` filters in SQL on the summary columns filled at insert: `max_stops`, `marketing_carriers[]`, `selling_total`, `itinerary_departure_minutes[]` / `itinerary_arrival_minutes[]` / `itinerary_duration_minutes[]` (per-itinerary windows and max duration), `main_cabin`, `min_checked_bags`, `refundable` / `changeable` (NULL = unknown, excluded when filtered), `branded_fares[]`. It sorts by `best_score`, `selling_total`, `total_duration_minutes`, `first_departure_local` or `last_arrival_local` within one search (at most 250 rows, found by `search_id`; `flight_offers_search_best_idx` / `_price_idx`). `flight_searches.facets` / `highlights` / `one_way_combinations` serve flights.getSearch. Markup comes from `markup_rules`. `offer_upsells` and the upsold `flight_offers` (`origin='upsell'`). `priced_offers` (include flags, `forceClass`, bags, other services, credit-card fees, detailed fare rules, `booking_requirements`; fees from `fee_rules`). `supplier_requests` logs every Amadeus call | `supplier_connections` (test/live credentials and offices), `reference` for dictionaries and display |
| **B3 Checkout, payments, bookings** (`/v1/checkouts`, `/v1/payments`, `/v1/bookings`) | Checkout: `checkouts` (`base_priced_offer_id` = the priced offer it was opened with; `priced_offer_id` = the current one, a child `priced_offers` row with `parent_priced_offer_id` = base after setAncillaries) + `checkout_travelers` (documents and discount eligibility encrypted) / `checkout_contacts` / `checkout_ancillaries` / `checkout_remarks` (special requests). Payment: `payments`, `payment_events`, `refunds`. Booking creation (Flight Create Orders, `issue`): `bookings`, `booking_associated_records`, `booking_travelers`, `booking_contacts`, `booking_segments`, `booking_ancillaries`, `booking_remarks` (incl. the copied checkout remarks), `booking_tickets`, `booking_events`, `booking_documents`, and `booking_access_tokens` for guest `X-Booking-Token` (the one-time token is replayed on retry only from `idempotency_keys.response_ciphertext`). Ticketing progress (`bookings.getTicketingStatus`, `ticketing.status`): `bookings.ticketing_status`, `ticketing_attempts`, `ticketing_last_attempt_at`, `ticketing_next_attempt_at`, `ticketing_error_code`. **My trips**: upcoming = `customer_id=$1 AND status IN (pending, confirmed, ticketed, partially_ticketed) AND last_arrival_at >= now() ORDER BY first_departure_at` (`bookings_customer_upcoming_idx`); past = same statuses and `last_arrival_at < now() ORDER BY first_departure_at DESC, id DESC` (the API's default `-departure`; `..._past_idx` is ordered that way and carries `last_arrival_at` as an INCLUDE column); cancelled (`..._cancelled_idx`). Guest lookup is reference + `lead_last_name`; modify (PATCH) and cancel (DELETE) bump `bookings.version` | `payment_provider_connections` (PSP of the environment) |
| **B4 Console** (`/v1/console/*`) | All bookings of the OTA, every index leading with `environment`: `bookings_created_idx` / `bookings_status_idx` / `bookings_ticketing_status_idx` (filter `ticketingStatus`) / `bookings_ticketing_deadline_idx` (all statuses, sort `ticketingDeadline`) / `bookings_departure_idx` / `bookings_total_idx` (sort `total`) / `bookings_validating_carrier_idx` / `bookings_created_by_staff_idx` / `bookings_contact_email_idx`, a GIN index on `tags`, plus last name and record locator search. Pricing (`ConsoleBookingPricing`): `pricing_mode` (markup_rules / net / override), `markup_rule_id`, `net_base_amount`, `taxes_amount`, `net_fees_amount`, `net_services_amount`, `markup_amount`, `fees_amount`, `card_fee_amount`, so imported and override bookings stay distinguishable. **PNR lookup** checks `bookings_record_locator_uq` and `booking_associated_records_lookup_idx`, then calls Get Flight Order By Record Locator and imports the order (`channel='import'`). Order retrieve, patch and cancel use `order_snapshot` and children; `If-Match` is checked against `version`, and Amadeus 2552 maps to `VERSION_CONFLICT`. Issue: `booking_tickets`, `booking_documents`, `booking_events`. Queues: `queue_snapshots`. Availability search: `flight_searches (kind='availability')`. Customers: `customers` and children; `q` uses the `text_pattern_ops` indexes on `lower(email)` (the unique index), `lower(first_name)` and `lower(last_name)`, and the sorts use `customers_name_sort_idx`, `customers_last_booking_idx` and `customers_total_spent_idx` (denormalised `last_booking_at` / `total_spent_amount`). Settings: `markup_rules`, `fee_rules`, `notification_templates`, `storefront_settings`. Diagnostics: `supplier_requests` (`supplier_requests_created_idx` / `_api_idx` / `_staff_idx` lead with `environment`; GIN on `error_codes`). Queue history: `queue_snapshots_fetched_idx` (`environment, fetched_at DESC`). Every console call writes `staff_actions` with its actor (staff `stf_`, secret API key `key_`, or system), reason and redacted before/after | Staff identity and roles from `tenant_memberships` and `accounts`. Offices and queue defaults from `supplier_connections` |

