-- velexis:phase expand
-- Add the price warnings of a plan's last comparison with its Stripe prices, kept with the plan

-- Lead decision (4c) of 2026-11-04, second set (FIX-W42-PLATFORM; PADR-0002 item 2, subscription-billing flow §A):
-- adminUpdatePlan and adminCheckPlanPrices write the warnings of their comparison with the plan's linked Stripe prices
-- here, under the plan's row lock, and every admin read of a plan takes AdminPlan.priceWarnings from this column. Until
-- now they were read back from the comparison's audit row (PBE-048), which a retention purge of platform_audit_log
-- (PADR-0006, Audit items 3 and 4) would take with it; the audit rows keep recording each comparison. A plan never
-- compared, or compared without a linked price, has none. No backfill (conventions §9): a plan compared before this
-- migration shows its warnings again after its next comparison. velexis_platform_app writes the column under the
-- table-level privileges it has on plans, and velexis_ota_app's table-level SELECT covers it (a warning names a price
-- field and two amounts, currencies, intervals or flags, nothing secret), so nothing is granted here.
ALTER TABLE platform.plans ADD COLUMN price_warnings jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT plans_price_warnings_ck CHECK (jsonb_typeof(price_warnings) = 'array');

COMMENT ON COLUMN platform.plans.price_warnings IS 'Differences found by the last comparison of the plan with its linked Stripe prices ([{field, expected, actual}], AdminPlan.priceWarnings); written by adminUpdatePlan and adminCheckPlanPrices under the plan''s row lock; empty when never compared or nothing is linked.';
