# Questions for counsel

Draft for counsel. Not legal advice. Nothing here is in force.

Part 1 of the [privacy pack](README.md). It holds the follow-up questions of [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) questions 19 and 20 (the lead's questions (45f) and (45g) to the owner, of 2026-11-26), and the facts counsel needs to answer them. The owner sends them to counsel. The facts are what the records and the plan say on 2026-11-27; a fact that rests on a proposal says so.

## 1. Counsel's answer, as the records hold it

On 2026-11-26 the owner relayed counsel's answer to the question "Is Velexis a processor for each OTA, or a controller of its own?". ADR-0030 question 4 records it in these words:

> "The counsel answered. "On request" is sufficient if OTA uses Velexis supply. They can switch to controller role and control it themselves if they use their own credentials. It's a role transition."

[PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md) question 1 records the same words. The records do not hold counsel's own date or the written source.

The lead reads it as follows (ADR-0030 question 4). This is the lead's reading, not counsel's, and counsel may correct it: for Velexis supply, disclosure on request is sufficient, so the branch "if a processor, "on request" may not be enough" does not apply; an OTA that uses its own credentials takes the controller role ("a role transition"), which first happens in milestone M8, after the launch.

This pack marks no question as answered. Only the owner records counsel's words.

## 2. The facts counsel needs

Some facts rest on the lead's proposals. ADR-0030 items 14 to 18, and the draft of its question 9, are Proposed (lead); accepted with the owner's go for wave 71 on 2026-11-27 (ADR-0030 item 26). PADR-0021 items 4 to 9 and the plan's assumption A35 stay proposals, and each is marked where it is used.

### 2.1 Who takes part

| Party | Role in a booking on Velexis supply |
|---|---|
| Traveller | Books a flight on an OTA's storefront, or is booked by OTA staff. Gives names, dates of birth, documents and contacts at checkout. Pays for the booking on the OTA's storefront. |
| OTA | Velexis's customer (a tenant). Sells the flight, talks to the traveller and moves the traveller's money, refunds included (plan §4.12). Is not shown which supplier served the booking. |
| Velexis | Hosts the OTA's storefront, admin and data on one server. Buys the flight from a supplier through Velexis's own supplier account and supplies it to the OTA. Pays PKFare from Velexis's PKFare wallet and recovers the cost from the OTA offline ([`decisions.md`](../decisions.md) §1, "Customer payments"). |
| Supplier | Sells the flight to Velexis and passes the booking to the airline: Amadeus Enterprise through Velexis's Amadeus account, with an office assigned to each OTA ([`decisions.md`](../decisions.md) §2); PKFare through Velexis's PKFare account (ADR-0030 items 3, 5 and 10). |
| Airline | Flies the traveller and issues the ticket. |

The legal names and countries of Velexis, Amadeus and PKFare are not in the records: `[Velexis legal name, country]`, `[Amadeus contracting entity, country]`, `[PKFare contracting entity, country]`.

### 2.2 Velexis supply and an OTA's own accounts

- By default an OTA uses Velexis supply ([`decisions.md`](../decisions.md) §2, the row "Whose supplier account").
- An OTA may later connect its own Amadeus or PKFare account with its own credentials, and then use Velexis supply, its own accounts, or both. This comes after the launch, in milestone M8 (ADR-0030 items 21 and 30). At the launch every OTA is on Velexis supply only.
- Today's code for an OTA's own Amadeus credentials stays behind the switch `FEATURE_OWN_AMADEUS`, which stays off at the launch (ADR-0030 item 21).

### 2.3 The hidden supplier

- For a booking on Velexis supply, no answer, screen, e-mail or document that the OTA or the traveller sees names the supplier: not its name, its data, its error codes, its call log or its order reference. This includes Amadeus when Velexis supplies it (ADR-0030 item 18; plan §4.7).
- Offers and bookings carry an opaque supply id instead (ADR-0030 items 3, 9, 14 and 15). If an id changes, a history keeps the earlier ids, and an old id still resolves ([PADR-0020](../../../platform/docs/adr/0020-supplier-registry-switches-and-suppliers-page.md) items 5 and 8).
- The traveller sees the airline's booking reference, or none until a ticket number exists (ADR-0030 item 17 and question 9).
- The OTA may ask which supplier served a booking (ADR-0030 item 9). Part 2, the [disclosure procedure](disclosure-procedure.md), is the draft of how.
- Limits of hiding: the published API still names Amadeus in some member names, and the supply id lets anyone count Velexis's sources (ADR-0030, Consequences; plan §9.3).

### 2.4 The traveller data that reach a supplier

| Supplier (Velexis's account) | What Velexis sends when it books | Source |
|---|---|---|
| Amadeus Enterprise | Each field only when the checkout holds it. For each traveller: names (first, middle, last, second last), date of birth, gender; travel documents (type, number, issue and expiry dates, issuing country and place, nationality, place and country of birth, country of validity, holder); loyalty programmes; discount cards; an emergency contact; and the traveller's own contact (name, address, phone numbers, e-mail, language). The booking's contacts as given at checkout: name, company, address, phone numbers, e-mail, language. Special requests as remarks, and the remark `VELEXIS <reference>`. The flights and fares. | The Flight Create Orders request of [`order-request.builder.ts`](../../../ota/backend/src/bookings/order-request.builder.ts) (`amadeusTravelerOf`, `documentOf`, `amadeusOrderContactOf`, `generalRemarksOf`) |
| PKFare (in live use only once PKFare certifies it; ADR-0030 item 28) | What PKFare's booking request takes, as no PKFare code exists yet. For each traveller: first and last name, date of birth, gender, nationality, passenger type, and the travel document (type, number, expiry) unless the price says none is needed; optional fields for a frequent flyer number and its airline, and the US known traveller (KTN) and redress numbers. The order's contact (name, e-mail, phone, postcode, address) and the buyer's e-mail and phone. The flights, fares, bags and seats. The contact e-mails and phone numbers are Velexis's own (§2.5); A35 does not say what goes in the contact's name and address, or which optional fields Velexis fills. | PKFare's reference in `docs/pkfare/`, PreciseBooking V8, the current version (read 2026-11-27); OBE-107's facts file is to confirm it |

- **Card data.** No card data goes to PKFare. Card data reach a supplier only on the airline-card path through Amadeus, where the traveller's card pays the airline: in memory, for one request, never stored or logged ([`decisions.md`](../decisions.md) §1, "Customer payments" (b); ADR-0011; plan §4.15).
- **At Velexis.** The traveller data live in the OTA's own database schema on Velexis's server. Travel documents are encrypted at rest ([ADR-0010](../adr/0010-secrets-envelope-encryption.md); `ota/docs/data-model.md` §4). The stored copies of supplier requests keep documents masked.
- **The reconciliation role.** Velexis staff in this role open one booking at a time, with a reason. Each action is audited and visible to the OTA. Their booking view shows travellers' names but no document number, contact or card detail (OBE-197). The facts that reach the platform's ledger carry no name, contact or document ([PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md) items 4 to 6, Proposed (lead); plan §4.13).

### 2.5 Velexis's own contacts on a supplier's order (A35)

Every contact e-mail and phone number that Velexis sends to PKFare for a booking on Velexis supply is a Velexis mailbox or number, not the traveller's (plan §3, A35, the plan's assumption, proposed). So PKFare's own e-mails reach Velexis, and Velexis staff pass them on to the OTA in neutral words (plan §4.7, last row). Whether the airline still reaches the traveller when the order holds a Velexis contact is a question for PKFare (plan §9.2). On Amadeus the booking's contacts are the traveller's, as today (§2.4).

### 2.6 The agreement on traveller data with each supplier

Velexis needs an agreement with each supplier that covers traveller data (plan §4.14; the plan's reading, for counsel to confirm). The records hold:

- PKFare: "PKFare agrees, we have signed up with them." (the owner, ADR-0030 item 10). Whether that agreement covers traveller data is not recorded.
- Amadeus: Velexis's Amadeus Enterprise account. Whether its agreement covers the traveller data of the OTAs that Velexis supplies is not recorded.
- The platform admin will keep, per Velexis supplier account, the legal name, address, country, privacy contact and agreement date (PBE-099). Part 4, the [recipients list](recipients-list.md), is the draft of the dated list built from them.

### 2.7 What the plan reads in the law

- A traveller who asks for the actual recipients of their data may be entitled to them, so the disclosure procedure always ends with a name (plan §4.14; the plan's reading, for counsel to confirm).
- Velexis needs an agreement with each supplier that covers traveller data, a dated list of recipients, and OTA terms that describe the procedure (plan §4.14; the plan's reading, for counsel to confirm).

### 2.8 When it matters

- The multi-supplier work is built before the launch (ADR-0030 item 19). As the lead reads it, the supplier is hidden in live use from the launch on.
- PKFare stays off in production until PKFare certifies it, and the launch does not wait for the certification (ADR-0030 item 28).
- An OTA's own supplier accounts, and so the role transition of counsel's answer, come after the launch, in M8 (ADR-0030 items 21 and 30).

## 3. Follow-up on counsel's answer (ADR-0030 question 19, (45f))

**19a. The date and the source.** On what date did counsel answer, and where is the written answer kept? The relay date is 2026-11-26. X-074's launch checklist item "Counsel" needs counsel's own date.

**19b. Velexis's own role under Velexis supply.** The relayed words do not say which role Velexis has when an OTA uses Velexis supply. Is Velexis a processor for each OTA, a controller of its own, or another role? For which processing: passing traveller data to the supplier (§2.4), hosting the OTA's data (§2.4), the reconciliation role (§2.4), the disclosure answer (part 2)?

**19c. What "on request" covers.** Does "on request" being sufficient also cover:

1. the procedure of PADR-0021 item 10 as drafted in [part 2](disclosure-procedure.md): who may ask (an OTA owner or admin), the answer within three working days, and what the answer holds (legal name, country and privacy contact at the booking's date);
2. a traveller's own request for the actual recipients of their data (§2.7): to whom does the traveller turn, the OTA or Velexis, and does the answer name the supplier;
3. the agreement with each supplier (§2.6): what it must hold for traveller data?

**19d. The texts that still gate tasks.** Did counsel give, or will counsel give, these texts? Each draft is in this pack where one exists.

| Text | Draft | Waiting task |
|---|---|---|
| The traveller notice | [Part 3](notice-text-block.md) | PBE-100 |
| The OTA terms clause | [Part 5](ota-terms-clause.md) | PFE-031 (the terms it publishes) |
| The wording for integrators: the sentences that tell an OTA's developers about hidden suppliers and about asking for the supplier behind an id | none in this pack | SDK-021, step 1 |
| The wording for sending a stored answer to the OTA by hand | [Part 2](disclosure-procedure.md), §4 | X-068, step 6; PBE-099 and PBE-100 |

The lead's recommendation in ADR-0030 question 19: the texts gate PBE-099, PBE-100, SDK-021 and X-068; X-074 needs the date.

**19e. The dated list of recipients.** Does counsel want the dated list of [part 4](recipients-list.md)? Who keeps it, who may see it, and how long are its earlier versions kept? (Not part of ADR-0030 question 19: plan §4.14 leaves the template to this pack.)

## 4. Follow-up on the role transition (ADR-0030 question 20, (45g))

Facts for these questions:

- An OTA may use Velexis supply and its own accounts at the same time (§2.2). One search can merge offers from both.
- The records already keep sources apart. Each offer and booking carries its supply id (ADR-0030 item 14). The reconciliation role never sees a booking on an OTA's own account, and its ledger and facts leave such bookings out (PADR-0021 items 4 and 5; Proposed (lead)). For an OTA's own source the OTA is shown the supplier, as today (plan §4.7).
- At sign-up the portal already stores which version of the terms an account accepted (`terms_version`, platform scope PF-01).
- Own accounts come after the launch, in M8 (§2.8).

**20a. Per booking or per OTA.** When an OTA uses both Velexis supply and its own accounts, is the controller role set per booking (by the booking's supply source) or per OTA?

**20b. What the OTA accepts.** What does an OTA accept when it moves to its own credentials?

**20c. The record of it.** Does the platform record that acceptance, and with what (a date, a terms version, the account it covers)?

The lead's recommendation in ADR-0030 question 20: per booking, as the records already keep sources apart; the acceptance step belongs to M8.

## 5. Where the answers go

Counsel answers to the owner. The owner records counsel's answers, with counsel's date, in the rows of ADR-0030 questions 19 and 20 and in PADR-0021. The drafts of parts 2 to 5 ask their own points for counsel at their end. No task starts on this pack's text: each waits for the approved text ([README](README.md) §4).
