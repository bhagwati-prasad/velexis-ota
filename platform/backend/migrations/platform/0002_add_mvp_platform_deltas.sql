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
-- =====================================================================================================
-- 5. Payment connections, settlements, payout accounts
-- =====================================================================================================

ALTER TABLE platform.payment_provider_connections
  ADD COLUMN account_mode                text NOT NULL DEFAULT 'velexis' CHECK (account_mode IN ('velexis','connect_standard','api_keys')),
  ADD COLUMN statement_descriptor_suffix text CHECK (statement_descriptor_suffix ~ '^[A-Za-z0-9][A-Za-z0-9 .&-]{1,21}$'),
  ADD COLUMN capabilities                jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN connected_at                timestamptz,
  ADD COLUMN disconnected_at             timestamptz,
  ADD COLUMN last_error                  text,
  ADD COLUMN created_by_account_id       text REFERENCES platform.accounts (id) ON DELETE SET NULL;
ALTER TABLE platform.payment_provider_connections ADD CONSTRAINT payment_provider_connections_mode_ck CHECK (
  (account_mode = 'velexis' AND provider = 'stripe' AND account_reference IS NULL
     AND secret_ciphertext IS NULL AND webhook_secret_ciphertext IS NULL)
  OR
  (account_mode = 'connect_standard' AND provider = 'stripe' AND account_reference ~ '^acct_[A-Za-z0-9]+$'
     AND secret_ciphertext IS NULL AND webhook_secret_ciphertext IS NULL)
  OR
  (account_mode = 'api_keys' AND provider = 'stripe' AND account_reference ~ '^acct_[A-Za-z0-9]+$'
     AND publishable_key IS NOT NULL AND secret_ciphertext IS NOT NULL
     AND webhook_secret_ciphertext IS NOT NULL AND encryption_key_id IS NOT NULL)
) NOT VALID;
ALTER TABLE platform.payment_provider_connections VALIDATE CONSTRAINT payment_provider_connections_mode_ck;
CREATE UNIQUE INDEX payment_provider_connections_connect_uq
  ON platform.payment_provider_connections (provider, environment, account_reference) WHERE account_mode = 'connect_standard';
COMMENT ON COLUMN platform.payment_provider_connections.account_mode IS 'velexis = Velexis Stripe account (default, settled monthly); connect_standard = OTA account through Connect OAuth; api_keys = OTA account through its own keys.';
COMMENT ON COLUMN platform.payment_provider_connections.statement_descriptor_suffix IS 'Card statement suffix with the OTA brand (velexis mode).';
COMMENT ON COLUMN platform.payment_provider_connections.capabilities IS 'Connected account state from Stripe: {chargesEnabled, payoutsEnabled, detailsSubmitted}.';
COMMENT ON COLUMN platform.payment_provider_connections.connected_at IS 'When the current OTA-owned account was connected.';
COMMENT ON COLUMN platform.payment_provider_connections.disconnected_at IS 'When the OTA deauthorised Velexis in Stripe (status disabled).';
COMMENT ON COLUMN platform.payment_provider_connections.last_error IS 'Last verification or provider error (no secrets).';
COMMENT ON COLUMN platform.payment_provider_connections.created_by_account_id IS 'Account that set up the current mode (NULL = provisioning).';

ALTER TABLE platform.plans
  ADD COLUMN stripe_product_id     text CHECK (stripe_product_id ~ '^prod_[A-Za-z0-9]+$'),
  ADD COLUMN stripe_price_id_month text CHECK (stripe_price_id_month ~ '^price_[A-Za-z0-9]+$'),
  ADD COLUMN stripe_price_id_year  text CHECK (stripe_price_id_year ~ '^price_[A-Za-z0-9]+$'),
  ADD COLUMN trial_days            integer NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 365),
  ADD COLUMN settlement_fee_bps    integer NOT NULL DEFAULT 0 CHECK (settlement_fee_bps BETWEEN 0 AND 10000);
CREATE UNIQUE INDEX plans_stripe_price_month_uq ON platform.plans (stripe_price_id_month) WHERE stripe_price_id_month IS NOT NULL;
CREATE UNIQUE INDEX plans_stripe_price_year_uq ON platform.plans (stripe_price_id_year) WHERE stripe_price_id_year IS NOT NULL;
COMMENT ON COLUMN platform.plans.stripe_product_id IS 'Stripe Product of the plan (set by a platform admin).';
COMMENT ON COLUMN platform.plans.stripe_price_id_month IS 'Stripe recurring Price for monthly billing.';
COMMENT ON COLUMN platform.plans.stripe_price_id_year IS 'Stripe recurring Price for annual billing.';
COMMENT ON COLUMN platform.plans.trial_days IS 'Free trial days on the first subscription of a tenant (Checkout and manual trials).';
COMMENT ON COLUMN platform.plans.settlement_fee_bps IS 'Velexis fee in basis points on net captured volume of velexis-mode payments, deducted in settlements.';

INSERT INTO platform.plans (code, name, description, currency, monthly_price, annual_price, per_booking_fee, included_bookings,
                            limits, features, is_public, is_active, sort_order, trial_days, settlement_fee_bps)
VALUES ('early_access', 'Early access', 'Free plan for OTAs created before paid plans open. Test mode only.', 'EUR', 0, NULL, 0, 0,
        '{"staffSeats":5,"apiKeys":10,"customDomains":0,"liveMode":false}'::jsonb, '{}'::jsonb, true, true, 0, 90, 0)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE platform.settlements (
  id                     text PRIMARY KEY CHECK (id LIKE 'stl\_%'),
  tenant_id              text NOT NULL REFERENCES platform.tenants (id) ON DELETE RESTRICT,
  environment            text NOT NULL DEFAULT 'live' CHECK (environment IN ('test','live')),
  currency               char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_start           timestamptz NOT NULL,
  period_end             timestamptz NOT NULL,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','carried_forward','void')),
  gross_amount           numeric(12,2) NOT NULL DEFAULT 0,
  refunds_amount         numeric(12,2) NOT NULL DEFAULT 0,
  disputes_amount        numeric(12,2) NOT NULL DEFAULT 0,
  stripe_fees_amount     numeric(12,2) NOT NULL DEFAULT 0,
  velexis_fees_amount    numeric(12,2) NOT NULL DEFAULT 0,
  adjustments_amount     numeric(12,2) NOT NULL DEFAULT 0,
  net_amount             numeric(12,2) NOT NULL DEFAULT 0,
  fee_bps                integer NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 10000),
  line_count             integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  carried_to_id          text REFERENCES platform.settlements (id) ON DELETE SET NULL,
  generated_at           timestamptz NOT NULL DEFAULT now(),
  approved_at            timestamptz,
  approved_by_account_id text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  paid_at                timestamptz,
  paid_by_account_id     text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  payout_reference       text,
  voided_at              timestamptz,
  void_reason            text,
  notes                  text,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_period_ck CHECK (period_end > period_start),
  CONSTRAINT settlements_net_ck CHECK (net_amount = gross_amount - refunds_amount - disputes_amount - stripe_fees_amount - velexis_fees_amount + adjustments_amount),
  CONSTRAINT settlements_paid_ck CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND payout_reference IS NOT NULL AND net_amount > 0)),
  CONSTRAINT settlements_carry_ck CHECK (status <> 'carried_forward' OR net_amount <= 0),
  CONSTRAINT settlements_void_ck CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX settlements_period_uq ON platform.settlements (tenant_id, environment, currency, period_start) WHERE status <> 'void';
CREATE INDEX settlements_status_idx ON platform.settlements (status, period_start);
COMMENT ON TABLE platform.settlements IS 'Monthly statement of payments Velexis collected for a tenant (velexis mode), built from Stripe balance transactions.';
COMMENT ON COLUMN platform.settlements.id IS 'Statement id (stl_ + ULID).';
COMMENT ON COLUMN platform.settlements.tenant_id IS 'Tenant the funds belong to.';
COMMENT ON COLUMN platform.settlements.environment IS 'live in production; test statements exist only in development.';
COMMENT ON COLUMN platform.settlements.currency IS 'Currency of the Velexis Stripe balance the transactions settled in.';
COMMENT ON COLUMN platform.settlements.period_start IS 'Inclusive start of the period (first day of the month, 00:00 UTC).';
COMMENT ON COLUMN platform.settlements.period_end IS 'Exclusive end of the period.';
COMMENT ON COLUMN platform.settlements.status IS 'draft, approved (to pay), paid, carried_forward (net <= 0) or void (drafts only).';
COMMENT ON COLUMN platform.settlements.gross_amount IS 'Sum of captured charges.';
COMMENT ON COLUMN platform.settlements.refunds_amount IS 'Sum of refunds (positive number).';
COMMENT ON COLUMN platform.settlements.disputes_amount IS 'Disputed amounts and dispute fees minus reinstated amounts.';
COMMENT ON COLUMN platform.settlements.stripe_fees_amount IS 'Stripe processing fees of the period.';
COMMENT ON COLUMN platform.settlements.velexis_fees_amount IS 'Velexis fee: fee_bps of (gross - refunds), never below 0.';
COMMENT ON COLUMN platform.settlements.adjustments_amount IS 'Manual adjustments and the carried-forward balance of earlier statements (signed).';
COMMENT ON COLUMN platform.settlements.net_amount IS 'Amount owed to the tenant (CHECK keeps the formula).';
COMMENT ON COLUMN platform.settlements.fee_bps IS 'Snapshot of plans.settlement_fee_bps at generation.';
COMMENT ON COLUMN platform.settlements.line_count IS 'Number of settlement_lines.';
COMMENT ON COLUMN platform.settlements.carried_to_id IS 'Statement that absorbed this negative or zero balance.';
COMMENT ON COLUMN platform.settlements.generated_at IS 'When the draft was (re)generated.';
COMMENT ON COLUMN platform.settlements.approved_at IS 'When a platform admin approved it.';
COMMENT ON COLUMN platform.settlements.approved_by_account_id IS 'Approving platform admin.';
COMMENT ON COLUMN platform.settlements.paid_at IS 'Date of the bank transfer.';
COMMENT ON COLUMN platform.settlements.paid_by_account_id IS 'Platform admin who recorded the payment.';
COMMENT ON COLUMN platform.settlements.payout_reference IS 'Bank transfer reference.';
COMMENT ON COLUMN platform.settlements.voided_at IS 'When a draft was voided.';
COMMENT ON COLUMN platform.settlements.void_reason IS 'Why the draft was voided.';
COMMENT ON COLUMN platform.settlements.notes IS 'Admin notes shown to the tenant.';
COMMENT ON COLUMN platform.settlements.version IS 'Optimistic-locking counter.';
COMMENT ON COLUMN platform.settlements.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.settlements.updated_at IS 'Last modification time.';

CREATE TABLE platform.settlement_lines (
  id                     text PRIMARY KEY CHECK (id LIKE 'sln\_%'),
  settlement_id          text NOT NULL REFERENCES platform.settlements (id) ON DELETE CASCADE,
  tenant_id              text NOT NULL REFERENCES platform.tenants (id) ON DELETE RESTRICT,
  line_type              text NOT NULL CHECK (line_type IN ('charge','refund','dispute','dispute_reversal','adjustment','carry_forward')),
  balance_transaction_id text UNIQUE CHECK (balance_transaction_id ~ '^txn_[A-Za-z0-9]+$'),
  source_id              text,
  payment_intent_id      text,
  velexis_payment_id     text,
  checkout_id            text,
  occurred_at            timestamptz NOT NULL,
  amount                 numeric(12,2) NOT NULL,
  stripe_fee             numeric(12,2) NOT NULL DEFAULT 0,
  original_amount        numeric(12,2),
  original_currency      char(3) CHECK (original_currency ~ '^[A-Z]{3}$'),
  description            text,
  created_by_account_id  text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_lines_txn_ck CHECK ((line_type IN ('adjustment','carry_forward')) = (balance_transaction_id IS NULL))
);
CREATE INDEX settlement_lines_settlement_idx ON platform.settlement_lines (settlement_id, occurred_at);
CREATE INDEX settlement_lines_tenant_idx ON platform.settlement_lines (tenant_id, occurred_at);
COMMENT ON TABLE platform.settlement_lines IS 'One Stripe balance transaction (or manual adjustment) per line; a balance transaction is settled at most once.';
COMMENT ON COLUMN platform.settlement_lines.id IS 'Line id (sln_ + ULID).';
COMMENT ON COLUMN platform.settlement_lines.settlement_id IS 'Statement the line belongs to.';
COMMENT ON COLUMN platform.settlement_lines.tenant_id IS 'Tenant (from metadata.velexis_tenant_id), repeated for queries.';
COMMENT ON COLUMN platform.settlement_lines.line_type IS 'charge, refund, dispute, dispute_reversal, adjustment or carry_forward.';
COMMENT ON COLUMN platform.settlement_lines.balance_transaction_id IS 'Stripe balance transaction (txn_); NULL for adjustments and carry-forwards.';
COMMENT ON COLUMN platform.settlement_lines.source_id IS 'Stripe source object: charge, refund or dispute id.';
COMMENT ON COLUMN platform.settlement_lines.payment_intent_id IS 'Stripe PaymentIntent (pi_) of the charge.';
COMMENT ON COLUMN platform.settlement_lines.velexis_payment_id IS 'Tenant payment id from metadata.payment_id (pay_), by value.';
COMMENT ON COLUMN platform.settlement_lines.checkout_id IS 'Tenant checkout id from metadata.checkout_id, by value.';
COMMENT ON COLUMN platform.settlement_lines.occurred_at IS 'Balance transaction creation time.';
COMMENT ON COLUMN platform.settlement_lines.amount IS 'Signed amount in the statement currency (refunds and disputes negative).';
COMMENT ON COLUMN platform.settlement_lines.stripe_fee IS 'Stripe fee of the balance transaction (positive = cost).';
COMMENT ON COLUMN platform.settlement_lines.original_amount IS 'Amount in the charge currency when it differs from the statement currency.';
COMMENT ON COLUMN platform.settlement_lines.original_currency IS 'Charge currency when converted.';
COMMENT ON COLUMN platform.settlement_lines.description IS 'Human-readable line text (no card data).';
COMMENT ON COLUMN platform.settlement_lines.created_by_account_id IS 'Platform admin who added a manual adjustment.';
COMMENT ON COLUMN platform.settlement_lines.created_at IS 'Row creation time.';

CREATE TABLE platform.tenant_payout_accounts (
  tenant_id               text PRIMARY KEY REFERENCES platform.tenants (id) ON DELETE RESTRICT,
  account_holder_name     text NOT NULL,
  country_code            char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  currency                char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  scheme                  text NOT NULL CHECK (scheme IN ('iban','local')),
  bank_details_ciphertext bytea NOT NULL,
  encryption_key_id       text NOT NULL,
  last4                   char(4) NOT NULL,
  status                  text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','verified','rejected')),
  review_note             text,
  reviewed_by_account_id  text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  reviewed_at             timestamptz,
  updated_by_account_id   text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.tenant_payout_accounts IS 'Bank account where Velexis pays a tenant''s settlements (velexis mode).';
COMMENT ON COLUMN platform.tenant_payout_accounts.tenant_id IS 'Tenant being paid.';
COMMENT ON COLUMN platform.tenant_payout_accounts.account_holder_name IS 'Legal name on the bank account.';
COMMENT ON COLUMN platform.tenant_payout_accounts.country_code IS 'Country of the bank.';
COMMENT ON COLUMN platform.tenant_payout_accounts.currency IS 'Currency of the bank account.';
COMMENT ON COLUMN platform.tenant_payout_accounts.scheme IS 'iban (IBAN + BIC) or local (account and routing numbers).';
COMMENT ON COLUMN platform.tenant_payout_accounts.bank_details_ciphertext IS 'Envelope-encrypted JSON of the bank identifiers.';
COMMENT ON COLUMN platform.tenant_payout_accounts.encryption_key_id IS 'KEK id that wraps the data key.';
COMMENT ON COLUMN platform.tenant_payout_accounts.last4 IS 'Last 4 characters of the IBAN or account number, for display.';
COMMENT ON COLUMN platform.tenant_payout_accounts.status IS 'pending_review until a platform admin verifies it; changes reset it.';
COMMENT ON COLUMN platform.tenant_payout_accounts.review_note IS 'Reason of a rejection.';
COMMENT ON COLUMN platform.tenant_payout_accounts.reviewed_by_account_id IS 'Platform admin who reviewed it.';
COMMENT ON COLUMN platform.tenant_payout_accounts.reviewed_at IS 'Review time.';
COMMENT ON COLUMN platform.tenant_payout_accounts.updated_by_account_id IS 'Owner who last changed it.';
COMMENT ON COLUMN platform.tenant_payout_accounts.version IS 'Optimistic-locking counter.';
COMMENT ON COLUMN platform.tenant_payout_accounts.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.tenant_payout_accounts.updated_at IS 'Last modification time.';
-- =====================================================================================================
-- 6. Billing: Stripe customers, subscription statuses, invoices, webhook inbox
-- =====================================================================================================

CREATE TABLE platform.billing_customers (
  tenant_id            text PRIMARY KEY REFERENCES platform.tenants (id) ON DELETE RESTRICT,
  provider             text NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_customer_id text NOT NULL UNIQUE CHECK (provider_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  livemode             boolean NOT NULL,
  billing_email        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.billing_customers IS 'The Stripe Customer that pays a tenant''s subscription; reused across re-subscriptions.';
COMMENT ON COLUMN platform.billing_customers.tenant_id IS 'Billed tenant.';
COMMENT ON COLUMN platform.billing_customers.provider IS 'Billing provider (stripe).';
COMMENT ON COLUMN platform.billing_customers.provider_customer_id IS 'Stripe Customer id (cus_).';
COMMENT ON COLUMN platform.billing_customers.livemode IS 'Whether the customer lives in Stripe live mode.';
COMMENT ON COLUMN platform.billing_customers.billing_email IS 'Invoice e-mail last synced from Stripe.';
COMMENT ON COLUMN platform.billing_customers.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.billing_customers.updated_at IS 'Last modification time.';

ALTER TABLE platform.subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE platform.subscriptions ADD CONSTRAINT subscriptions_status_ck
  CHECK (status IN ('trialing','active','past_due','paused','canceled','incomplete','incomplete_expired','unpaid')) NOT VALID;
ALTER TABLE platform.subscriptions VALIDATE CONSTRAINT subscriptions_status_ck;
DROP INDEX platform.subscriptions_current_uq;
CREATE UNIQUE INDEX subscriptions_current_uq ON platform.subscriptions (tenant_id)
  WHERE status IN ('trialing','active','past_due','paused','incomplete','unpaid');
ALTER TABLE platform.subscriptions
  ADD COLUMN provider_price_id   text,
  ADD COLUMN checkout_session_id text,
  ADD COLUMN provider_synced_at  timestamptz;
COMMENT ON COLUMN platform.subscriptions.provider_price_id IS 'Stripe Price currently subscribed (maps to plan and interval).';
COMMENT ON COLUMN platform.subscriptions.checkout_session_id IS 'Stripe Checkout Session that created the subscription.';
COMMENT ON COLUMN platform.subscriptions.provider_synced_at IS 'Last re-fetch of the subscription from Stripe.';

ALTER TABLE platform.invoices
  ADD COLUMN hosted_invoice_url text,
  ADD COLUMN invoice_pdf_url    text,
  ADD COLUMN provider_synced_at timestamptz;
COMMENT ON COLUMN platform.invoices.hosted_invoice_url IS 'Stripe-hosted invoice page.';
COMMENT ON COLUMN platform.invoices.invoice_pdf_url IS 'Stripe-hosted invoice PDF (pdf_storage_key stays NULL in the MVP).';
COMMENT ON COLUMN platform.invoices.provider_synced_at IS 'Last re-fetch of the invoice from Stripe.';

CREATE TABLE platform.stripe_events (
  id                text PRIMARY KEY CHECK (id LIKE 'evt\_%'),
  endpoint          text NOT NULL CHECK (endpoint IN ('billing','connect_accounts')),
  type              text NOT NULL,
  livemode          boolean NOT NULL,
  account           text,
  object_type       text,
  object_id         text,
  api_version       text,
  stripe_created_at timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','ignored','failed')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error        text,
  tenant_id         text REFERENCES platform.tenants (id) ON DELETE SET NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_events_open_idx ON platform.stripe_events (received_at) WHERE status IN ('received','failed');
CREATE INDEX stripe_events_object_idx ON platform.stripe_events (object_id);
CREATE INDEX stripe_events_tenant_idx ON platform.stripe_events (tenant_id, received_at DESC) WHERE tenant_id IS NOT NULL;
COMMENT ON TABLE platform.stripe_events IS 'Inbox of Stripe webhook events received by the platform (billing and Connect account events); the event id makes delivery idempotent.';
COMMENT ON COLUMN platform.stripe_events.id IS 'Stripe event id (evt_).';
COMMENT ON COLUMN platform.stripe_events.endpoint IS 'Receiving endpoint: billing or connect_accounts.';
COMMENT ON COLUMN platform.stripe_events.type IS 'Stripe event type, e.g. customer.subscription.updated.';
COMMENT ON COLUMN platform.stripe_events.livemode IS 'Stripe livemode flag of the event.';
COMMENT ON COLUMN platform.stripe_events.account IS 'Connected account id (acct_) for Connect events.';
COMMENT ON COLUMN platform.stripe_events.object_type IS 'Type of data.object (subscription, invoice, checkout.session, account).';
COMMENT ON COLUMN platform.stripe_events.object_id IS 'Id of data.object; handlers re-fetch it from Stripe.';
COMMENT ON COLUMN platform.stripe_events.api_version IS 'Stripe API version of the event payload.';
COMMENT ON COLUMN platform.stripe_events.stripe_created_at IS 'Event creation time at Stripe.';
COMMENT ON COLUMN platform.stripe_events.status IS 'received, processing, processed, ignored or failed.';
COMMENT ON COLUMN platform.stripe_events.attempts IS 'Processing attempts.';
COMMENT ON COLUMN platform.stripe_events.last_error IS 'Last processing error (no secrets).';
COMMENT ON COLUMN platform.stripe_events.tenant_id IS 'Tenant the event was resolved to (NULL if unknown).';
COMMENT ON COLUMN platform.stripe_events.received_at IS 'When the webhook was received.';
COMMENT ON COLUMN platform.stripe_events.processed_at IS 'When processing finished.';
COMMENT ON COLUMN platform.stripe_events.updated_at IS 'Last modification time.';

-- =====================================================================================================
-- 7. E-mail outbox and audit privileges
-- =====================================================================================================

CREATE TABLE platform.email_outbox (
  id                        text PRIMARY KEY CHECK (id LIKE 'eml\_%'),
  template                  text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_.]{2,63}$'),
  to_email                  text NOT NULL CHECK (position('@' in to_email) > 1),
  account_id                text REFERENCES platform.accounts (id) ON DELETE SET NULL,
  tenant_id                 text REFERENCES platform.tenants (id) ON DELETE SET NULL,
  locale                    text NOT NULL DEFAULT 'en',
  data                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_payload_ciphertext bytea,
  encryption_key_id         text,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','canceled')),
  attempts                  integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error                text,
  provider_message_id       text,
  sent_at                   timestamptz,
  secrets_purged_at         timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_outbox_secret_key_ck CHECK (secret_payload_ciphertext IS NULL OR encryption_key_id IS NOT NULL),
  CONSTRAINT email_outbox_secret_purge_ck CHECK (status IN ('pending','sending') OR secret_payload_ciphertext IS NULL)
);
CREATE INDEX email_outbox_open_idx ON platform.email_outbox (created_at) WHERE status IN ('pending','sending');
CREATE INDEX email_outbox_account_idx ON platform.email_outbox (account_id, created_at DESC) WHERE account_id IS NOT NULL;
COMMENT ON TABLE platform.email_outbox IS 'Platform e-mails waiting to be sent or sent; secret links are encrypted and erased at a final status.';
COMMENT ON COLUMN platform.email_outbox.id IS 'E-mail id (eml_ + ULID); the only field in the platform-emails job.';
COMMENT ON COLUMN platform.email_outbox.template IS 'Template key, e.g. auth.verify_email, tenant.welcome.';
COMMENT ON COLUMN platform.email_outbox.to_email IS 'Recipient address (portal account or OTA billing contact, never a traveller).';
COMMENT ON COLUMN platform.email_outbox.account_id IS 'Recipient account when there is one.';
COMMENT ON COLUMN platform.email_outbox.tenant_id IS 'OTA the e-mail is about.';
COMMENT ON COLUMN platform.email_outbox.locale IS 'Template locale (en in the MVP).';
COMMENT ON COLUMN platform.email_outbox.data IS 'Non-secret template variables from the template allow-list.';
COMMENT ON COLUMN platform.email_outbox.secret_payload_ciphertext IS 'Envelope-encrypted secret variables (links with tokens); erased at sent, failed or canceled.';
COMMENT ON COLUMN platform.email_outbox.encryption_key_id IS 'KEK id that wraps the data key.';
COMMENT ON COLUMN platform.email_outbox.status IS 'pending, sending, sent, failed or canceled.';
COMMENT ON COLUMN platform.email_outbox.attempts IS 'Send attempts.';
COMMENT ON COLUMN platform.email_outbox.last_error IS 'Last SMTP error (no secrets).';
COMMENT ON COLUMN platform.email_outbox.provider_message_id IS 'Message id returned by the SMTP server.';
COMMENT ON COLUMN platform.email_outbox.sent_at IS 'When the SMTP server accepted the message.';
COMMENT ON COLUMN platform.email_outbox.secrets_purged_at IS 'When secret_payload_ciphertext was erased.';
COMMENT ON COLUMN platform.email_outbox.created_at IS 'Row creation time.';
COMMENT ON COLUMN platform.email_outbox.updated_at IS 'Last modification time.';

CREATE INDEX platform_audit_log_target_idx ON platform.platform_audit_log (target_type, target_id, created_at DESC);

-- =====================================================================================================
-- 8. Privileges (roles are created by deploy/scripts/dev-setup.sh and provision-vm.sh)
-- =====================================================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  platform.account_tokens, platform.account_recovery_codes, platform.amadeus_accounts, platform.amadeus_offices,
  platform.credential_submissions, platform.settlements, platform.settlement_lines, platform.tenant_payout_accounts,
  platform.billing_customers, platform.stripe_events, platform.email_outbox
  TO velexis_platform_app;
REVOKE UPDATE, DELETE, TRUNCATE ON platform.platform_audit_log FROM velexis_platform_app;
GRANT SELECT ON platform.amadeus_accounts, platform.amadeus_offices TO velexis_ota_app;
