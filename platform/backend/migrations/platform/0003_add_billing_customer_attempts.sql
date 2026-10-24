-- velexis:phase expand
-- Add the attempts of a tenant's Stripe Customer creation, so a Stripe 5xx moves the next attempt to a new key

-- PADR-0002 item 3, revision of 2026-10-24 (FIX-W29-PLATFORM): `customers.create` of a tenant's first Checkout uses the
-- Stripe idempotency key `customer:<tenant_id>` (attempt 0, no row) or `customer:<tenant_id>:<attempt>`. Stripe replays
-- a stored 5xx for the same key for 24 hours, so after a 5xx, a timeout or a key Stripe refuses, the attempt moves on
-- and the next Checkout looks for a Customer made by the earlier attempt before it creates one. The row stays after the
-- Customer is stored in billing_customers; the OTA backend never reads it.
CREATE TABLE platform.billing_customer_attempts (
  tenant_id  text PRIMARY KEY REFERENCES platform.tenants (id) ON DELETE RESTRICT,
  attempt    integer NOT NULL CHECK (attempt >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.billing_customer_attempts IS 'The attempt of a tenant''s Stripe Customer creation after a failed one; no row means attempt 0.';
COMMENT ON COLUMN platform.billing_customer_attempts.tenant_id IS 'Tenant whose Stripe Customer is being created.';
COMMENT ON COLUMN platform.billing_customer_attempts.attempt IS 'Attempt of the next customers.create: Stripe idempotency key customer:<tenant_id>:<attempt>.';
COMMENT ON COLUMN platform.billing_customer_attempts.updated_at IS 'When a failed attempt moved it on.';

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.billing_customer_attempts TO velexis_platform_app;
