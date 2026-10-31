# PADR-0003: Settlement of Velexis-collected payments

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when more than about 20 OTAs are settled each month, when a payout fails or is disputed, or when legal review requires a reserve or a different funds flow.
**Revisions:** 2026-10-30 (lead decision (2g) of 2026-10-30, third batch, recorded with FIX-W36-PLATFORM): item 3 names what the generator does with a balance transaction category it does not know (skipped, with a warning line of its type and id); item 5 counts a dispute fee once, in `disputes`, never again in `stripe_fees`; item 7 says which draft absorbs a carried-forward balance (the earliest later open draft of the same tenant, environment and currency) and that a tenant whose only open item is such a balance gets a draft holding it (dated notes under items 3, 5 and 7). The Consequences follow.

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §2: by default OTAs take payments on **Velexis's Stripe account**, and Velexis settles to the OTA. [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) fixes the outline: a monthly statement per OTA built from Stripe balance transactions filtered by `metadata.velexis_tenant_id`, stored in a platform table, paid by bank transfer and marked paid in the platform admin. The platform never reads tenant schemas ([ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)). Left open: the period, the formula, refunds and disputes after a payout, negative balances, currencies, fees, bank details and the approval steps.

## Decision

1. **Scope.** Only payments in `velexis` mode, live environment. Connect and API-key modes pay the OTA directly. Airline-card payments never touch Stripe. Test-mode statements can be generated in development only.
2. **Period.** Calendar months in UTC. On day 3 at 05:00 UTC a job builds drafts for the previous month, leaving two days for late events.
3. **Source of truth.** Stripe balance transactions of the Velexis account with `created` in the period, listed once for all tenants with `source` expanded. The tenant comes from `metadata.velexis_tenant_id` on the charge, or on its PaymentIntent when the charge lacks it; refunds and disputes resolve through their charge. Transactions without a tenant (Velexis's own subscription income, payouts, platform fees) are ignored.
   - *Note (2026-10-30, lead decision (2g), FIX-W36-PLATFORM).* The `reporting_category` decides what a transaction is. `charge`, `refund`, `refund_failure`, `dispute` and `dispute_reversal` are settled; a `refund_failure` (a refund that failed, its money back on the balance) stays a **positive** `refund` line, so it lowers the refunds of its month. The categories of Velexis's own money (payouts and their reversals, Stripe's own fees and the tax on them, transfers, top-ups, Connect and reserve movements, contributions) are skipped without a word. Every other category is one the generator does not know: it is skipped too, never guessed into a line, and the run logs **one warning line per such transaction** (`settlement.unknown_category`) with its type and id only, never an amount, a source or metadata, so a category Stripe adds is looked at and, if it carries an OTA's money, settled by a later change or an admin's adjustment.
4. **Grouping.** One statement per tenant and **balance currency** (the currency of Velexis's Stripe balance in which the transaction settled). The charge's original currency and amount are kept on the line for reference.
5. **Formula**, per statement:
   `net = gross − refunds − disputes − stripe_fees − velexis_fees + adjustments`
   - `gross`: captured charges; `refunds`: refunded amounts; `disputes`: disputed amounts and dispute fees minus reinstated amounts;
   - `stripe_fees`: the `fee` of every included balance transaction (Velexis passes Stripe's actual fees through);
   - `velexis_fees = round_half_even(fee_bps × max(gross − refunds, 0) / 10 000)`, `fee_bps` copied from `plans.settlement_fee_bps` at generation (0 by default);
   - `adjustments`: manual lines (reason required) and the carried-forward balance.
   A CHECK constraint keeps the stored totals consistent.
   - *Note (2026-10-30, lead decision (2g), FIX-W36-PLATFORM).* **A dispute fee counts once**, in `disputes`: `stripe_fees` is the `fee` of every included balance transaction **except the dispute ones** (`dispute`, `dispute_reversal`), whose fee is the dispute fee (or, negative, the dispute fee Stripe gives back with a won dispute) and is already in `disputes` (`disputes = −Σ (amount − fee)` of those lines). So `stripe_fees` holds the processing fees only, `net` is the sum of the lines' amounts less their fees and the Velexis fee, and the statement reconciles with Stripe's balance and with the CSV of its lines. The data model's column comments say the same (`disputes_amount`: "disputed amounts and dispute fees minus reinstated amounts"; `stripe_fees_amount`: "Stripe processing fees"). `platform/backend/src/settlements/settlement-formula.ts` computes it.
6. **Events after a payout** (late refunds, disputes) are simply lines of the month in which they happen. No statement is ever reopened.
7. **Negative or zero balances** are approved as `carried_forward` and absorbed by the next month's draft as a `carry_forward` line; `carried_to_id` is set when the absorbing statement is approved. Velexis does not invoice OTAs for negative balances in the MVP; persistent negatives are handled by the admin with the OTA (and, if needed, suspension).
   - *Note (2026-10-30, lead decision (2g), FIX-W36-PLATFORM): the carry-forward rule.* "The next month's draft" is **the earliest later open draft** of the same tenant, environment and currency: a `carried_forward` statement whose `carried_to_id` is still null is absorbed by a draft of a later month only when no other draft of that tenant, environment and currency lies between the two months; while such an earlier draft is open, a later one leaves the balance to it, so two open drafts never count one balance twice. When that draft is voided, the next draft takes the balance over; when it is approved, `carried_to_id` points at it and no other statement absorbs the balance again (the approval re-checks it, PBE-060). A tenant whose **only open item** is such a balance (no transaction in the month, no statement of the month yet) still gets a draft of the month, holding just that `carry_forward` line, so the balance reaches the admin's review and is carried on as the rules above say; balances that sum to zero open no draft. Generating a month for one tenant (`tenantId`) does this for that tenant only. `platform/backend/src/settlements/settlement-generator.ts` and `settlements.repository.ts` (`unabsorbedCarryForwards`, `carryForwardKeys`) carry it out.
8. **No double settlement.** Each balance transaction appears on at most one line (unique `balance_transaction_id`). Regenerating a draft deletes and rebuilds only that draft's lines; voiding a draft deletes its lines; `approved`, `paid` and `carried_forward` statements are immutable.
9. **States**: `draft` → `approved` (net > 0) → `paid`; `draft` → `carried_forward` (net ≤ 0); `draft` → `void`. Approval and marking paid need a platform admin with a recent MFA step-up, a verified payout account (for net > 0) and `If-Match`.
10. **Payout account.** The owner enters bank details in the portal (MFA step-up). They are envelope-encrypted in `tenant_payout_accounts`, shown masked (`last4`) everywhere, and revealed in full only to an admin who gives a reason; every reveal is audited. Any change returns the account to `pending_review` until an admin verifies it. Go-live in `velexis` mode requires a verified payout account.
11. **Payment** happens outside the system (bank transfer from Velexis's account after Stripe's payouts arrive). The admin records the date and bank reference; owners and finance members are e-mailed; the portal lists statements and their CSV lines.
12. **No reserve** is held in the MVP.

## Consequences

### Positive

- Figures come from the money that actually moved through Stripe, including fees, so they reconcile with Stripe's own reports.
- Statements are immutable once approved; corrections are visible lines, which auditors and OTAs can follow.
- The platform stays out of tenant schemas.
- A dispute costs the OTA its amount and the dispute fee once, and a negative balance reaches the admin every month until it is absorbed, even in a month without transactions (revision of 2026-10-30).

### Negative

- Manual transfers and reviews cost the developer time every month.
- An OTA that stays negative gets a draft to review every month; a balance transaction of a category Stripe adds is skipped until someone reads its warning line and decides (revision of 2026-10-30).
- Velexis carries chargeback risk on paid-out funds until a later statement absorbs it; without a reserve, an OTA that leaves with a negative balance is a loss.
- Money held for OTAs may be restricted by Stripe's terms and payment-services rules; [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) requires legal review and Stripe's written confirmation before live payments.

### Follow-ups

- Legal review and Stripe confirmation before the first live `velexis`-mode payment (M5 exit criterion).
- Consider a rolling reserve (for example 10 % for 90 days) or Connect destination charges if disputes appear.
- Automate payouts (bank API or Stripe Connect transfers) when volume justifies it.

## Alternatives considered

- **Figures from tenant `payments` tables.** Rejected: the platform cannot read tenant schemas, and Stripe is closer to the real money.
- **Settle per payout (Stripe payout ids)** instead of per month. Payouts mix all tenants; mapping them back adds complexity for no benefit at MVP volume.
- **Stripe Connect transfers from day one.** Requires each OTA to have a connected account, which the product owner wants to avoid for quick onboarding.

## References

- [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md)
- [`../flows/stripe-payments-account.md`](../flows/stripe-payments-account.md) §B and §F, [`../data-model.md`](../data-model.md) §4.5
- Stripe balance transactions: <https://docs.stripe.com/api/balance_transactions>
