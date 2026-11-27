# Disclosure procedure: which supplier served a booking

Draft for counsel. Not legal advice. Nothing here is in force.

Part 2 of the [privacy pack](README.md). It drafts the procedure of [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md) item 10, "Disclosure on request" (Proposed (lead); accepted with the owner's go for wave 71 on 2026-11-27 (ADR-0030 item 26)). Counsel's answer, as the owner relayed it on 2026-11-26, says that "on request" is sufficient with Velexis supply. It does not address this procedure: who asks, the three working days, or what the answer holds (PADR-0021 item 10, its note of 2026-11-26; [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 19). So the procedure stays a draft for counsel to approve or change.

PBE-100 builds the request, PBE-099 the answer, and X-068 the runbook "disclosure request" of the platform's operations.

## 1. The OTA asks

1. An owner or an admin of the OTA asks in the portal: on the Suppliers page, in the section "Velexis", with the form "Ask which supplier served a booking" (PBE-100). Agents, finance members and viewers of the OTA cannot ask.
2. The request names the booking's reference, the booking's supply id and the booking's date (PBE-100, step 2).
3. A supply id that the OTA never had is refused. The same booking asked again while it is unanswered adds no second request (PBE-100, step 3).
4. The request is stored without an answer, and the platform admins get one alert. Nothing the portal shows at this step names a supplier (PBE-100, steps 3 and 4).

## 2. Velexis answers

5. A platform admin answers within three working days (PADR-0021 item 10, which takes the deadline from the plan's A39). The admin uses the page "Disclosures" of the platform admin and gives a reason (PBE-099, step 5).
6. The answer comes from the id history. The supply id, current or old, resolves to the supply source that held it at the booking's date, and to that source's Velexis supplier account (PBE-099, step 3). A rotated id still resolves ([PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md) item 8).
7. The answer holds the legal name, country and privacy contact of the supplier that served the booking at that date, from the recipient fields of the account ([part 4](recipients-list.md)). PBE-099 keeps one row of these fields per account, without their history (its step 2), so the answer gives them as they stand when the admin answers.
8. The answer is stored with who gave it and when, and the audit log records `supply.disclosed` with the reason. A later change of the account's fields changes no stored answer (PBE-099, acceptance).

## 3. It always ends with a name

9. An account without a legal name or a privacy contact makes the answer refuse, and nothing is stored (PBE-099, step 4). A platform admin then completes the account's recipient fields and answers again.
10. The reason for this rule: a traveller who asks for the actual recipients of their data may be entitled to them (plan §4.14; the plan's reading, for counsel to confirm).

## 4. The answer reaches the OTA

11. Before the launch, the portal shows the OTA the state of its request, never the answer (PBE-100, step 4).
12. A platform admin sends the stored answer to the OTA by hand, once counsel's wording allows it (the lead's ruling S15 in plan Annex D; X-068, step 6). Counsel's answer, as relayed, gives no such wording (ADR-0030 question 19), so this step waits.
13. Draft of the message, for counsel's wording:

> Subject: Your question about booking `[booking reference]`
>
> You asked on `[date asked]` which supplier served booking `[booking reference]` (supply id `[supply id]`, booked on `[booking date]`).
>
> The supplier was `[legal name]`, `[country]`. Its privacy contact is `[privacy contact]`.
>
> `[Counsel to state: what the OTA may do with this answer, whether it may pass it to the traveller, and whether it is confidential.]`
>
> Velexis

14. The runbook "disclosure request" of X-068 holds this step. Draft for it: a platform admin sends the message from `[Velexis's support mailbox]` to `[the OTA owner or admin who asked]`. `[Counsel to state whether the sending needs a record of its own.]`

## 5. Points for counsel

- **Who may ask.** Only an OTA's owner or admin (step 1). Should others ask too: the traveller, or any member of the OTA?
- **A traveller's own request.** The procedure has no step for a traveller who asks Velexis or the OTA directly for the recipients of their data. ADR-0030 question 19 asks whether "on request" covers it.
- **The deadline.** Three working days (step 5) is part of PADR-0021 item 10, which the owner accepted with the go for wave 71; counsel's relayed answer does not address it. Is it right, and from when does it run?
- **The content.** Legal name, country and privacy contact of the booking's supplier (step 7). Is that enough, or should the answer also hold the address, the purpose, or the agreement's date ([part 4](recipients-list.md))? If a supplier's fields change between the booking and the answer, the answer gives the newer ones (step 7). Is that acceptable, or must the answer give the fields of the booking's date?
- **The way back.** By hand before the launch (step 12). Is a message by e-mail acceptable, and with which wording?
- **Keeping the record.** The request and the answer stay stored and audited. How long should they be kept?
