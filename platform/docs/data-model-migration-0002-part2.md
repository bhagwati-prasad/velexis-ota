# Migration 0002, part 2 of 3

This document continues the exact SQL of `platform/backend/migrations/platform/0002_add_mvp_platform_deltas.sql` after [part 1](data-model-migration-0002.md): the Stripe account modes of `payment_provider_connections`, the Stripe price links and settlement fee of `plans` with the `early_access` seed plan, and the new `settlements`, `settlement_lines` and `tenant_payout_accounts` tables. [Part 3](data-model-migration-0002-part3.md) follows.

Related: [`data-model.md`](data-model.md) (why each change is needed), [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (runner and baselines), [`conventions.md` §9](../../docs/mvp/conventions.md#9-database-migrations) (migration rules).

## SQL

```sql
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
```
