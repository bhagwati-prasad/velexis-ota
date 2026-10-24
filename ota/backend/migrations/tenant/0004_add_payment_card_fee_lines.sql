-- velexis:phase expand
-- Payments: the card fee's lines, each with whether a cancellation refunds it.

-- Lead decision (2) of 2026-10-23, second batch (FIX-W28-CANCEL, OADR-0005 point 7, OADR-0010 point 6): a payment's
-- card fee (`card_fee_amount`) is the Amadeus credit-card fee plus the OTA's `payment_card` fee rules, and a
-- cancellation keeps it unless its rule is refundable (`fee_rules.refundable`; the Amadeus fee is never refundable).
-- The rule's flag can change or the rule be deleted after the payment, so each line is stored with the payment when the
-- fee is quoted: [{source, ruleId, amount, refundable}]. Payments written before keep an empty list (no backfill:
-- conventions §9), which counts as nothing refundable: their whole card fee is kept.
ALTER TABLE payments ADD COLUMN card_fee_lines jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT payments_card_fee_lines_ck CHECK (jsonb_typeof(card_fee_lines) = 'array');

COMMENT ON COLUMN payments.card_fee_lines IS 'The lines of card_fee_amount when the fee was quoted ([{source: amadeus | fee_rule, ruleId, amount, refundable}]): a cancellation refunds only the refundable ones; empty (payments before the column) = nothing refundable.';
