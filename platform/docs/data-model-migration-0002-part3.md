# Migration 0002, part 3 of 3

This document ends the exact SQL of `platform/backend/migrations/platform/0002_add_mvp_platform_deltas.sql` after [part 1](data-model-migration-0002.md) and [part 2](data-model-migration-0002-part2.md): the Stripe Billing customer table, the wider subscription status list, Stripe-hosted invoice links, the Stripe webhook inbox, the platform e-mail outbox, the audit target index, and the privileges of the new tables.

Related: [`data-model.md`](data-model.md) (why each change is needed), [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) (runner and baselines), [`conventions.md` §9](../../docs/mvp/conventions.md#9-database-migrations) (migration rules).

## SQL

```sql
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
```
