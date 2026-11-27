# Terms clause: Velexis supply and the supplier on request

Draft for counsel. Not legal advice. Nothing here is in force.

Part 5 of the [privacy pack](README.md). It drafts the clause for the terms between Velexis and an OTA. Plan §4.14 says that the OTA terms must describe the disclosure procedure (the plan's reading, for counsel to confirm). [ADR-0030](../adr/0030-suppliers-supply-sources-and-ingestion-engine.md) question 19 asks whether counsel gave this clause.

**Where the approved text goes.** The terms of service are the portal's legal page `/legal/terms`. PFE-031 publishes the owner's approved terms there, word for word, under a new terms version that sign-up stores (PFE-031, steps 1 to 3). This draft goes into no page.

## 1. The draft

Text in square brackets is for counsel to choose or fill in. "You" is the OTA; "Velexis" is `[Velexis legal name]`.

> **Flight supply by Velexis**
>
> 1. **Velexis supply.** Unless you connect your own supplier account, Velexis supplies the flights you sell. Velexis buys them from flight suppliers through its own accounts and pays those suppliers. `[Counsel to state the roles of Velexis and of you for the traveller data of these bookings (question 19b).]`
>
> 2. **Traveller data.** To book a flight, Velexis passes the travellers' booking data to the flight supplier and, through it, to the airline. The data are those listed in Velexis's privacy notice. `[For some suppliers, Velexis gives its own contact details to the supplier instead of the traveller's. Velexis passes on to you, in neutral words, any message from the supplier that concerns your traveller.]`
>
> 3. **The supplier is not named.** Velexis does not show you which flight supplier served a booking. Each offer and booking carries an opaque supply id instead. A supply id may change; Velexis keeps the earlier ids.
>
> 4. **Asking for the supplier.** Your owner or an admin may ask, on the Suppliers page of the Velexis portal, which supplier served a booking, by giving the booking's reference, its supply id and its date. Velexis answers within `[three working days]` with the supplier's legal name, country and privacy contact at the booking's date. Velexis keeps a record of each question and answer.
>
> 5. **Using the answer.** `[Counsel to state what you may do with the answer: pass it to the traveller who asked; use it for your own records; keep it confidential otherwise.]`
>
> 6. **Requests from travellers.** `[Counsel to state how a traveller's request about the recipients of their data is handled: you ask Velexis under clause 4 and answer the traveller; or the traveller may write to Velexis at [privacy contact].]`
>
> 7. **Velexis support staff.** Velexis staff who handle supplier questions for Velexis supply may open one of your bookings at a time, with a reason. Each such action is recorded, and you see it in your audit list.
>
> 8. **Your own supplier accounts.** `[When you connect your own supplier account, the supplier is shown to you for the bookings of that account, and you deal with that supplier yourself. Counsel to state the role you then have, whether it is set per booking or for your whole agency, and what you accept when you connect the account (question 20).]`

## 2. Notes for counsel

- **Clause 1** depends on question 19b of [part 1](questions.md): the relayed answer does not name Velexis's role under Velexis supply.
- **Clause 2** follows the plan's assumption A35 for PKFare (part 1 §2.5): proposed, not decided.
- **Clause 3** follows the owner's decisions (ADR-0030 items 3, 9 and 11).
- **Clause 4** follows the draft procedure of [part 2](disclosure-procedure.md). It changes if counsel changes the procedure. The portal page and the platform admin's answer are tasks PBE-100 and PBE-099.
- **Clause 7** follows [PADR-0021](../../../platform/docs/adr/0021-reconciliation-role-ledger-and-cases.md) item 4, a proposal of the lead.
- **Clause 8** concerns milestone M8, after the launch (ADR-0030 items 21 and 30). Counsel may leave it out of the terms at the launch.
- **Acceptance.** Sign-up stores the terms version an account accepted (platform scope PF-01). Accounts that signed up earlier keep the version they accepted; PFE-031 adds no re-acceptance (its step 3). Should OTAs that signed up before this clause accept it again?
