# Migration 0002, part 1 of 3

This document holds the exact SQL of the platform migration `platform/backend/migrations/platform/0002_add_mvp_platform_deltas.sql`, which applies every MVP delta to the `platform` baseline (`0001_baseline.sql` = [`docs/velexis-sdk/db/platform.sql`](../../docs/velexis-sdk/db/platform.sql)). The file is long, so it is printed in three consecutive parts; the migration file is their concatenation in order, with no other text. Part 1 covers identity, tenants and provisioning, domains and Amadeus. [Part 2](data-model-migration-0002-part2.md) covers payment connections, plans, settlements and payout accounts. [Part 3](data-model-migration-0002-part3.md) covers billing, the Stripe event inbox, the e-mail outbox and privileges.

Related: [`data-model.md`](data-model.md) (why each change is needed), [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (runner and baselines), [`conventions.md` §9](../../docs/mvp/conventions.md#9-database-migrations) (migration rules).

## How to use it

- Create the file by concatenating the three SQL blocks (parts 1, 2, 3) exactly. Do not reformat it: the runner stores its SHA-256 checksum.
- It is an **expand** migration. It runs in one transaction with `lock_timeout = 5s`. All tables touched are empty or tiny when it lands (first M1 backend task), so the `NOT VALID` + `VALIDATE` pairs and the index rebuild are instant.
- It was checked on PostgreSQL 16 against the baseline: it applies cleanly, and the constraints reject an underscore key, a live connection on the test Amadeus account, a second current subscription, a wrong settlement net, a duplicate balance transaction, a sent e-mail that still holds a secret, and OTA reads of settlements.
- It names the baseline's inline CHECK `subscriptions_status_check` (PostgreSQL's generated name). An integration test asserts that the old constraint is gone and the new statuses are accepted.
- The roles `velexis_platform_app` and `velexis_ota_app` must exist (`deploy/scripts/dev-setup.sh`, `provision-vm.sh`). Schema `USAGE` and the baseline table grants come from the foundation tasks. Those scripts must **not** re-grant `UPDATE` or `DELETE` on `platform.platform_audit_log`.
- After it runs: `pnpm db:codegen` and commit the regenerated types.

## SQL

```sql
-- velexis:phase expand
-- MVP platform deltas: identity tokens, tenant live switch, Amadeus account pool, payment modes, billing, settlements, e-mail outbox

-- =====================================================================================================
-- 1. Identity
-- =====================================================================================================

ALTER TABLE platform.accounts
  ADD COLUMN terms_accepted_at   timestamptz,
  ADD COLUMN terms_version       text,
  ADD COLUMN mfa_enabled_at      timestamptz,
  ADD COLUMN password_changed_at timestamptz;
COMMENT ON COLUMN platform.accounts.terms_accepted_at IS 'When the person accepted the portal terms at sign-up.';
COMMENT ON COLUMN platform.accounts.terms_version IS 'Version label of the accepted terms, e.g. 2026-10.';
COMMENT ON COLUMN platform.accounts.mfa_enabled_at IS 'When TOTP MFA was last enabled (NULL when disabled).';
COMMENT ON COLUMN platform.accounts.password_changed_at IS 'Last password change or reset; staff sessions created before it are denied.';

ALTER TABLE platform.account_sessions
  ADD COLUMN audience          text NOT NULL DEFAULT 'portal' CHECK (audience IN ('portal','platform_admin')),
  ADD COLUMN family_expires_at timestamptz,
  ADD COLUMN mfa_verified_at   timestamptz,
  ADD CONSTRAINT account_sessions_family_expiry_ck CHECK (family_expires_at IS NULL OR expires_at <= family_expires_at);
COMMENT ON COLUMN platform.account_sessions.audience IS 'Which app the refresh token belongs to: portal or platform_admin; never interchangeable.';
COMMENT ON COLUMN platform.account_sessions.family_expires_at IS 'Absolute end of the rotation family (30 days portal, 12 hours admin).';
COMMENT ON COLUMN platform.account_sessions.mfa_verified_at IS 'Last TOTP verification in this family; becomes the mfa_at claim for step-up checks.';

CREATE TABLE platform.account_tokens (
  id          text PRIMARY KEY CHECK (id LIKE 'atk\_%'),
  account_id  text NOT NULL REFERENCES platform.accounts (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  token_hash  text NOT NULL UNIQUE,
  email       text NOT NULL CHECK (position('@' in email) > 1),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_account_idx ON platform.account_tokens (account_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX account_tokens_expires_idx ON platform.account_tokens (expires_at);
COMMENT ON TABLE platform.account_tokens IS 'Single-use e-mail verification (24 h) and password reset (1 h) tokens; only SHA-256 hashes are stored.';
COMMENT ON COLUMN platform.account_tokens.id IS 'Token row id (atk_ + ULID).';
COMMENT ON COLUMN platform.account_tokens.account_id IS 'Account the token acts on.';
COMMENT ON COLUMN platform.account_tokens.purpose IS 'email_verification or password_reset.';
COMMENT ON COLUMN platform.account_tokens.token_hash IS 'SHA-256 of the 256-bit token sent by e-mail (the token itself is never stored).';
COMMENT ON COLUMN platform.account_tokens.email IS 'Address the token was sent to (the address being verified).';
COMMENT ON COLUMN platform.account_tokens.expires_at IS 'Expiry of the token.';
COMMENT ON COLUMN platform.account_tokens.consumed_at IS 'When the token was used (NULL = unused); a token works once.';
COMMENT ON COLUMN platform.account_tokens.ip_address IS 'Client IP of the request that created the token.';
COMMENT ON COLUMN platform.account_tokens.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.account_tokens.updated_at IS 'Last modification time.';

CREATE TABLE platform.account_recovery_codes (
  account_id text NOT NULL REFERENCES platform.accounts (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, code_hash)
);
COMMENT ON TABLE platform.account_recovery_codes IS 'Ten one-time MFA recovery codes per account (80-bit random codes, SHA-256 hashed); regenerating replaces all of them.';
COMMENT ON COLUMN platform.account_recovery_codes.account_id IS 'Account that owns the code.';
COMMENT ON COLUMN platform.account_recovery_codes.code_hash IS 'SHA-256 of the normalised recovery code.';
COMMENT ON COLUMN platform.account_recovery_codes.used_at IS 'When the code was used (NULL = unused).';
COMMENT ON COLUMN platform.account_recovery_codes.created_at IS 'When the code set was generated.';

-- =====================================================================================================
-- 2. Tenants and provisioning
-- =====================================================================================================

ALTER TABLE platform.tenants
  ADD COLUMN storefront_environment     text NOT NULL DEFAULT 'test' CHECK (storefront_environment IN ('test','live')),
  ADD COLUMN live_enabled_at            timestamptz,
  ADD COLUMN live_enabled_by_account_id text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  ADD COLUMN billing_notice             text CHECK (billing_notice IN ('past_due','trial_ending')),
  ADD CONSTRAINT tenants_live_ck CHECK (storefront_environment = 'test' OR live_enabled_at IS NOT NULL);
ALTER TABLE platform.tenants ADD CONSTRAINT tenants_key_dns_ck CHECK (key ~ '^[a-z][a-z0-9]{2,29}$') NOT VALID;
ALTER TABLE platform.tenants VALIDATE CONSTRAINT tenants_key_dns_ck;
ALTER TABLE platform.tenants ADD CONSTRAINT tenants_suspension_reason_ck
  CHECK (suspension_reason IS NULL OR suspension_reason IN ('billing','abuse','request','admin')) NOT VALID;
ALTER TABLE platform.tenants VALIDATE CONSTRAINT tenants_suspension_reason_ck;
COMMENT ON COLUMN platform.tenants.storefront_environment IS 'Environment of the hosted storefront and edge requests: test until the OTA goes live.';
COMMENT ON COLUMN platform.tenants.live_enabled_at IS 'When the owner switched the storefront to live.';
COMMENT ON COLUMN platform.tenants.live_enabled_by_account_id IS 'Owner who switched the storefront to live.';
COMMENT ON COLUMN platform.tenants.billing_notice IS 'Billing banner for the portal and the OTA admin (past_due, trial_ending), set by billing sync; NULL = none.';
COMMENT ON CONSTRAINT tenants_key_dns_ck ON platform.tenants IS 'The key is a DNS label of <key>.ota.example.com: 3-30 lower-case letters and digits, no underscore.';

ALTER TABLE platform.provisioning_jobs
  ADD COLUMN reveal_ciphertext        bytea,
  ADD COLUMN reveal_encryption_key_id text,
  ADD COLUMN revealed_at              timestamptz,
  ADD COLUMN revealed_by_account_id   text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  ADD CONSTRAINT provisioning_jobs_reveal_ck CHECK (reveal_ciphertext IS NULL OR (reveal_encryption_key_id IS NOT NULL AND revealed_at IS NULL));
CREATE INDEX provisioning_jobs_running_idx ON platform.provisioning_jobs (locked_until) WHERE status = 'running';
CREATE INDEX provisioning_jobs_reveal_idx ON platform.provisioning_jobs (finished_at) WHERE reveal_ciphertext IS NOT NULL;
COMMENT ON COLUMN platform.provisioning_jobs.reveal_ciphertext IS 'Envelope-encrypted raw test API keys issued at provisioning, for one reveal; erased on reveal or after 24 h.';
COMMENT ON COLUMN platform.provisioning_jobs.reveal_encryption_key_id IS 'KEK id that wraps the data key of reveal_ciphertext.';
COMMENT ON COLUMN platform.provisioning_jobs.revealed_at IS 'When the keys were revealed (the ciphertext is erased in the same update).';
COMMENT ON COLUMN platform.provisioning_jobs.revealed_by_account_id IS 'Owner who revealed the keys.';

-- =====================================================================================================
-- 3. Domains
-- =====================================================================================================

ALTER TABLE platform.tenant_domains
  ADD COLUMN verification_deadline_at timestamptz,
  ADD COLUMN last_checked_at          timestamptz,
  ADD COLUMN check_failures           integer NOT NULL DEFAULT 0 CHECK (check_failures >= 0),
  ADD COLUMN last_check_error         text,
  ADD COLUMN tls_checked_at           timestamptz,
  ADD COLUMN created_by_account_id    text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  ADD CONSTRAINT tenant_domains_custom_token_ck CHECK (kind = 'subdomain' OR verification_token IS NOT NULL);
CREATE INDEX tenant_domains_pending_idx ON platform.tenant_domains (verification_deadline_at) WHERE verification_status = 'pending';
CREATE INDEX tenant_domains_tenant_idx ON platform.tenant_domains (tenant_id);
COMMENT ON COLUMN platform.tenant_domains.verification_deadline_at IS 'End of the 72-hour DNS verification window of a pending custom domain.';
COMMENT ON COLUMN platform.tenant_domains.last_checked_at IS 'Last DNS check (verification or daily re-check).';
COMMENT ON COLUMN platform.tenant_domains.check_failures IS 'Consecutive failed daily re-checks of a verified domain; 3 sets it to failed.';
COMMENT ON COLUMN platform.tenant_domains.last_check_error IS 'Short reason of the last failed check (no secrets), shown in the portal.';
COMMENT ON COLUMN platform.tenant_domains.tls_checked_at IS 'Last TLS probe of the host.';
COMMENT ON COLUMN platform.tenant_domains.created_by_account_id IS 'Account that added the domain (NULL for the provisioned sub-domain).';

-- =====================================================================================================
-- 4. Amadeus: Velexis shared account, office pool, connection source
-- =====================================================================================================

CREATE TABLE platform.amadeus_accounts (
  id                       text PRIMARY KEY CHECK (id LIKE 'ama\_%'),
  name                     text NOT NULL,
  environment              text NOT NULL CHECK (environment IN ('test','live')),
  base_url                 text NOT NULL CHECK (base_url ~ '^https://' OR base_url ~ '^http://127\.0\.0\.1(:[0-9]+)?$'),
  client_id                text NOT NULL,
  client_secret_ciphertext bytea NOT NULL,
  encryption_key_id        text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending_verification'
                           CHECK (status IN ('pending_verification','active','invalid_credentials','disabled')),
  last_verified_at         timestamptz,
  last_error               text,
  created_by_account_id    text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amadeus_accounts_environment_uq UNIQUE (environment),
  CONSTRAINT amadeus_accounts_id_env_uq UNIQUE (id, environment)
);
COMMENT ON TABLE platform.amadeus_accounts IS 'Velexis-owned Amadeus Enterprise credentials (one per environment) shared by OTAs through assigned offices.';
COMMENT ON COLUMN platform.amadeus_accounts.id IS 'Account id (ama_ + ULID).';
COMMENT ON COLUMN platform.amadeus_accounts.name IS 'Label shown in the platform admin.';
COMMENT ON COLUMN platform.amadeus_accounts.environment IS 'test or live.';
COMMENT ON COLUMN platform.amadeus_accounts.base_url IS 'Amadeus API host (https), or the loopback stub in development.';
COMMENT ON COLUMN platform.amadeus_accounts.client_id IS 'OAuth2 client id issued by Amadeus to Velexis.';
COMMENT ON COLUMN platform.amadeus_accounts.client_secret_ciphertext IS 'Envelope-encrypted OAuth2 client secret.';
COMMENT ON COLUMN platform.amadeus_accounts.encryption_key_id IS 'KEK id that wraps the data key of the secret.';
COMMENT ON COLUMN platform.amadeus_accounts.status IS 'Credential health after the last verification.';
COMMENT ON COLUMN platform.amadeus_accounts.last_verified_at IS 'Last successful OAuth token request.';
COMMENT ON COLUMN platform.amadeus_accounts.last_error IS 'Last verification error (no secrets).';
COMMENT ON COLUMN platform.amadeus_accounts.created_by_account_id IS 'Platform admin who configured it.';
COMMENT ON COLUMN platform.amadeus_accounts.version IS 'Optimistic-locking counter.';
COMMENT ON COLUMN platform.amadeus_accounts.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.amadeus_accounts.updated_at IS 'Last modification time.';

CREATE TABLE platform.amadeus_offices (
  id                   text PRIMARY KEY CHECK (id LIKE 'amo\_%'),
  amadeus_account_id   text NOT NULL REFERENCES platform.amadeus_accounts (id) ON DELETE RESTRICT,
  office_id            text NOT NULL CHECK (office_id ~ '^[A-Z0-9]{9}$'),
  status               text NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','releasing','retired')),
  assigned_tenant_id   text REFERENCES platform.tenants (id) ON DELETE RESTRICT,
  assigned_at          timestamptz,
  release_requested_at timestamptz,
  released_at          timestamptz,
  notes                text,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amadeus_offices_account_office_uq UNIQUE (amadeus_account_id, office_id),
  CONSTRAINT amadeus_offices_assignment_ck CHECK ((status IN ('assigned','releasing')) = (assigned_tenant_id IS NOT NULL))
);
CREATE UNIQUE INDEX amadeus_offices_one_assigned_uq ON platform.amadeus_offices (amadeus_account_id, assigned_tenant_id) WHERE status = 'assigned';
CREATE INDEX amadeus_offices_pool_idx ON platform.amadeus_offices (amadeus_account_id, created_at) WHERE status = 'available';
CREATE INDEX amadeus_offices_tenant_idx ON platform.amadeus_offices (assigned_tenant_id) WHERE assigned_tenant_id IS NOT NULL;
COMMENT ON TABLE platform.amadeus_offices IS 'Pool of Velexis office ids per shared account; an office serves at most one tenant.';
COMMENT ON COLUMN platform.amadeus_offices.id IS 'Pool entry id (amo_ + ULID).';
COMMENT ON COLUMN platform.amadeus_offices.amadeus_account_id IS 'Shared account the office belongs to (gives the environment).';
COMMENT ON COLUMN platform.amadeus_offices.office_id IS 'Amadeus office id, e.g. NCE1A0955.';
COMMENT ON COLUMN platform.amadeus_offices.status IS 'available, assigned, releasing (tenant moved away, old orders may still use it) or retired.';
COMMENT ON COLUMN platform.amadeus_offices.assigned_tenant_id IS 'Tenant using the office (set while assigned or releasing).';
COMMENT ON COLUMN platform.amadeus_offices.assigned_at IS 'When the office was assigned.';
COMMENT ON COLUMN platform.amadeus_offices.release_requested_at IS 'When the tenant stopped using it (start of releasing).';
COMMENT ON COLUMN platform.amadeus_offices.released_at IS 'When a platform admin returned it to the pool.';
COMMENT ON COLUMN platform.amadeus_offices.notes IS 'Admin notes (commercial onboarding, ticketing agreements).';
COMMENT ON COLUMN platform.amadeus_offices.version IS 'Optimistic-locking counter.';
COMMENT ON COLUMN platform.amadeus_offices.created_at IS 'When the office was added to the pool.';
COMMENT ON COLUMN platform.amadeus_offices.updated_at IS 'Last modification time.';

ALTER TABLE platform.supplier_connections
  ADD COLUMN credential_source  text NOT NULL DEFAULT 'tenant' CHECK (credential_source IN ('velexis','tenant')),
  ADD COLUMN amadeus_account_id text;
ALTER TABLE platform.supplier_connections ALTER COLUMN credential_source DROP DEFAULT;
ALTER TABLE platform.supplier_connections
  ALTER COLUMN base_url DROP NOT NULL,
  ALTER COLUMN client_id DROP NOT NULL,
  ALTER COLUMN client_secret_ciphertext DROP NOT NULL,
  ALTER COLUMN encryption_key_id DROP NOT NULL;
ALTER TABLE platform.supplier_connections
  ADD CONSTRAINT supplier_connections_account_fk FOREIGN KEY (amadeus_account_id, environment)
    REFERENCES platform.amadeus_accounts (id, environment) ON DELETE RESTRICT;
ALTER TABLE platform.supplier_connections ADD CONSTRAINT supplier_connections_source_ck CHECK (
  (credential_source = 'tenant' AND amadeus_account_id IS NULL AND base_url IS NOT NULL
     AND client_id IS NOT NULL AND client_secret_ciphertext IS NOT NULL AND encryption_key_id IS NOT NULL)
  OR
  (credential_source = 'velexis' AND amadeus_account_id IS NOT NULL AND base_url IS NULL
     AND client_id IS NULL AND client_secret_ciphertext IS NULL AND encryption_key_id IS NULL)
) NOT VALID;
ALTER TABLE platform.supplier_connections VALIDATE CONSTRAINT supplier_connections_source_ck;
CREATE INDEX supplier_connections_account_idx ON platform.supplier_connections (amadeus_account_id) WHERE amadeus_account_id IS NOT NULL;
COMMENT ON COLUMN platform.supplier_connections.credential_source IS 'velexis = Velexis shared account through assigned offices; tenant = the OTA''s own credentials.';
COMMENT ON COLUMN platform.supplier_connections.amadeus_account_id IS 'Shared account used when credential_source = velexis (same environment, composite FK).';

CREATE TABLE platform.credential_submissions (
  id                        text PRIMARY KEY CHECK (id LIKE 'crs\_%'),
  tenant_id                 text NOT NULL REFERENCES platform.tenants (id) ON DELETE CASCADE,
  kind                      text NOT NULL CHECK (kind IN ('amadeus','stripe_api_keys')),
  environment               text NOT NULL CHECK (environment IN ('test','live')),
  public_data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext         bytea,
  webhook_secret_ciphertext bytea,
  encryption_key_id         text,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verifying','applied','failed','superseded')),
  error_code                text,
  error_message             text,
  attempts                  integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  submitted_by_account_id   text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  finished_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_submissions_open_secret_ck CHECK (status NOT IN ('pending','verifying') OR (secret_ciphertext IS NOT NULL AND encryption_key_id IS NOT NULL)),
  CONSTRAINT credential_submissions_secret_purge_ck CHECK (status IN ('pending','verifying') OR (secret_ciphertext IS NULL AND webhook_secret_ciphertext IS NULL))
);
CREATE UNIQUE INDEX credential_submissions_open_uq ON platform.credential_submissions (tenant_id, kind, environment) WHERE status IN ('pending','verifying');
CREATE INDEX credential_submissions_tenant_idx ON platform.credential_submissions (tenant_id, created_at DESC);
COMMENT ON TABLE platform.credential_submissions IS 'OTA-entered Amadeus credentials or Stripe API keys waiting for verification; secrets are erased when the submission ends.';
COMMENT ON COLUMN platform.credential_submissions.id IS 'Submission id (crs_ + ULID).';
COMMENT ON COLUMN platform.credential_submissions.tenant_id IS 'Tenant whose connection the submission would replace.';
COMMENT ON COLUMN platform.credential_submissions.kind IS 'amadeus (own Amadeus credentials) or stripe_api_keys (own Stripe keys).';
COMMENT ON COLUMN platform.credential_submissions.environment IS 'Environment of the target connection.';
COMMENT ON COLUMN platform.credential_submissions.public_data IS 'Non-secret fields: clientId, baseUrl, officeIds, default/queuing/owner office, or publishableKey.';
COMMENT ON COLUMN platform.credential_submissions.secret_ciphertext IS 'Envelope-encrypted Amadeus client secret or Stripe secret key (NULL once finished).';
COMMENT ON COLUMN platform.credential_submissions.webhook_secret_ciphertext IS 'Envelope-encrypted Stripe webhook signing secret (stripe_api_keys only; NULL once finished).';
COMMENT ON COLUMN platform.credential_submissions.encryption_key_id IS 'KEK id that wraps the data keys.';
COMMENT ON COLUMN platform.credential_submissions.status IS 'pending, verifying, applied, failed or superseded (a newer submission replaced it).';
COMMENT ON COLUMN platform.credential_submissions.error_code IS 'Verification error code shown to the OTA, e.g. AMADEUS_CREDENTIALS_INVALID.';
COMMENT ON COLUMN platform.credential_submissions.error_message IS 'Sanitised verification error (no secrets, no raw provider body).';
COMMENT ON COLUMN platform.credential_submissions.attempts IS 'Verification attempts made.';
COMMENT ON COLUMN platform.credential_submissions.submitted_by_account_id IS 'Owner or admin who entered the credentials.';
COMMENT ON COLUMN platform.credential_submissions.finished_at IS 'When the submission reached a final status.';
COMMENT ON COLUMN platform.credential_submissions.created_at IS 'Submission time.';
COMMENT ON COLUMN platform.credential_submissions.updated_at IS 'Last modification time.';
```
