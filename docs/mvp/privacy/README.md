# Privacy pack for counsel: hidden suppliers

Draft for counsel. Not legal advice. Nothing here is in force.

This pack is for the owner's counsel. It holds the questions that are still open about the hidden supplier, the facts counsel needs to answer them, and four drafts for counsel to approve, change or reject. Task X-052 of [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote it, as its dated note of 2026-11-26 re-scopes it (Proposed (lead); accepted with the owner's go for wave 71 on 2026-11-27 (ADR-0030 item 26)). The pack decides nothing. No part of it is published, and no record changes because of it.

## 1. Why there is a pack

On 2026-11-24 the owner decided that an OTA on Velexis supply is not shown which supplier Velexis uses. The OTA sees an opaque id, and it may ask ([`decisions.md`](../decisions.md) §2, the row "Whose supplier account"; [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) items 3 and 9). The plan asked counsel one question first: is Velexis a processor for each OTA, or a controller of its own? If a processor, is disclosure "on request" enough? ([multi-supplier plan](../plans/multi-supplier-plan.md) §4.14.)

On 2026-11-26 the owner relayed counsel's answer. ADR-0030 question 4 records it in these words:

> "The counsel answered. "On request" is sufficient if OTA uses Velexis supply. They can switch to controller role and control it themselves if they use their own credentials. It's a role transition."

The records hold this answer: ADR-0030 question 4 and [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md) question 1. This pack quotes it and marks nothing as answered. The relayed words leave points open, which ADR-0030 asks as questions 19 and 20 (the lead's questions (45f) and (45g) to the owner). Part 1 asks them again for counsel, with the facts.

## 2. The five parts

| Part | File | What it holds |
|---|---|---|
| 1. Questions | [`questions.md`](questions.md) | The follow-up questions of ADR-0030 questions 19 and 20, and the facts counsel needs for them: the traveller data that reach a supplier, the hidden supplier, Velexis's own contacts on a supplier's order, and the agreement with each supplier |
| 2. Procedure | [`disclosure-procedure.md`](disclosure-procedure.md) | Draft: how an OTA asks which supplier served a booking, and how Velexis answers (PADR-0021 item 10) |
| 3. Notice text block | [`notice-text-block.md`](notice-text-block.md) | Draft: the text that says Velexis passes traveller data to flight suppliers it does not name, and names one on request |
| 4. Recipients list | [`recipients-list.md`](recipients-list.md) | Draft: the template of the dated list of recipients |
| 5. Terms clause | [`ota-terms-clause.md`](ota-terms-clause.md) | Draft: the clause for the OTA terms that describes Velexis supply, the hidden supplier and the procedure |

## 3. Rules of the pack

- Every file says under its title that it is a draft for counsel, not legal advice, and not in force.
- Where the pack reads the law, it says so: "the plan's reading, for counsel to confirm". The pack quotes counsel only from the records, in the words the owner relayed.
- Text in square brackets, such as `[legal name]`, is for counsel or the owner to fill in or to choose.
- No text of this pack goes into `LEGAL_STRINGS` (`platform/frontend/src/lib/strings.ts`), into any page, e-mail or document of an app, or into the SDK guide. An agent never writes, completes or rewords legal text: the tasks that publish it take the text counsel approved, word for word (PFE-031, step 1; PBE-100, step 1).
- Only the owner records counsel's answers and approved texts, in the records. A changed draft in this pack is still a draft.

## 4. How the pack is used

1. The owner sends the pack to counsel.
2. Counsel answers the questions of part 1 and approves, changes or rejects each draft of parts 2 to 5.
3. The owner records counsel's answer, with counsel's own date, in the records: the rows of ADR-0030 questions 19 and 20, and PADR-0021.
4. The tasks that wait for counsel's texts then take the approved text word for word:

| Text | Task | Where it goes |
|---|---|---|
| The notice text (part 3) | PBE-100, steps 1 and 5 | the portal's legal pages (`LEGAL_STRINGS`), which PFE-031 publishes |
| The OTA terms clause (part 5) | PFE-031, step 1 | the portal's terms of service |
| The wording for sending a stored answer to the OTA by hand (part 2, §4) | X-068, step 6; PBE-099 (its notes); PBE-100, step 4 | the runbook "disclosure request" |
| The wording for integrators | SDK-021, step 1 | the SDK guide's chapter on supply ids and hidden suppliers |
| Counsel's own date | X-074, step 4 | the launch checklist's item "Counsel" |

The procedure of part 2 is built by PBE-099 (the platform admin's answer) and PBE-100 (the OTA's request). The recipient fields of part 4 are PBE-099's.

## 5. The counsel gate

The pack changes nothing about the counsel gate of PADR-0021 item 11: no supplier is hidden in live use before counsel answers PADR-0021 question 1. Its dated note of 2026-11-26 holds the lead's reading that the gate's condition is met for Velexis supply. Counsel's texts for an OTA or a traveller are other gates (ADR-0030 question 19). Only the owner records counsel's answer.

## 6. Words used

| Word | Meaning here |
|---|---|
| OTA | An online travel agency that Velexis hosts as a tenant. It sells flights to travellers through its storefront and runs its bookings in the OTA admin. |
| Traveller | A person who books, or is booked, through an OTA's storefront or staff. |
| Supplier | A company that sells flight content to Velexis or to an OTA: Amadeus Enterprise today, PKFare second. The airline flies and tickets the traveller. |
| Velexis supply | The default: Velexis buys the flights through its own supplier accounts and supplies them to the OTA. The OTA is not shown which supplier Velexis uses. |
| An OTA's own account | A supplier account in the OTA's own name, with its own credentials. It comes after the launch, in milestone M8 (ADR-0030 items 21 and 30). |
| Supply id | The opaque id that offers and bookings carry instead of the supplier's name. It belongs to a supply source, which is one supplier used through one account (ADR-0030 items 14 and 15; Proposed (lead); accepted with the owner's go for wave 71 on 2026-11-27 (ADR-0030 item 26)). If an id changes, a history keeps the earlier ids (PADR-0020 item 5). |

## 7. Sources

- [`decisions.md`](../decisions.md) §1 ("Customer payments") and §2 (the supplier rows)
- [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md): items 3, 5, 9 to 11, 14, 15, 17 to 19, 21, 26, 28 and 30; questions 4, 9, 19 and 20
- [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md): items 3 to 11; question 1
- [PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md): items 5 and 8
- The [multi-supplier plan](../plans/multi-supplier-plan.md): §3 (A35, A39), §4.7, §4.12 to §4.15, §8, §9.2, §9.3, §9.6 item 6 and Annex D (S15)
- [ADR-0010](../adr/0010-secrets-envelope-encryption.md), [ADR-0011](../adr/0011-payments-stripe-and-airline-card.md) and [ADR-0012](../adr/0012-amadeus-account-model.md); `ota/docs/data-model.md` §4; platform scope PF-01
- [`order-request.builder.ts`](../../../ota/backend/src/bookings/order-request.builder.ts) (Amadeus) and PKFare's PreciseBooking V8 in `docs/pkfare/`
- The task blocks of PBE-099 and PBE-100 ([`platform/docs/plans/agent-tasks.md`](../../../platform/docs/plans/agent-tasks.md)), PFE-031 (same file), SDK-021, OBE-107 and OBE-197 ([`ota/docs/plans/agent-tasks.md`](../../../ota/docs/plans/agent-tasks.md)), X-068 and X-074 ([`../plans/foundation-tasks.md`](../plans/foundation-tasks.md))
