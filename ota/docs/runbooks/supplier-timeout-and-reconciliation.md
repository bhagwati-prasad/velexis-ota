# Runbook: Amadeus slow or down, unknown booking outcomes and orphan PNRs

For an Amadeus outage or slowdown, for the bookings whose order may exist after a `504 SUPPLIER_TIMEOUT` (the reconciliation decides them; some come to the staff), and for orphan PNRs, PNRs on an OTA's booking queue that no booking of the OTA owns. The behaviour behind it is [OADR-0003](../adr/0003-booking-orchestration-and-supplier-timeout-recovery.md) and [architecture-booking §4](../architecture-booking.md#4-supplier_timeout-recovery); the levels of the escalation are those of the [runbooks README](README.md#3-escalation).

## 1. What the system does by itself

Nothing has to be restarted for an Amadeus outage, and no setting is changed during one:

- Searches, prices and the other reads answer `504 SUPPLIER_TIMEOUT` or `503 SUPPLIER_UNAVAILABLE` after their per-operation timeout; a read is tried once more on a timeout or a `5xx`. Stored bookings and documents stay readable ([architecture §10](../architecture.md#10-failure-behaviour)).
- **Flight Create Orders is never sent twice for one checkout.** When its answer is lost (a timeout, a cut connection, an Amadeus `5xx`, an unreadable answer) the booking stays `pending` with `reconcile_until` 15 minutes after the request, its authorisation and checkout are kept, the traveller gets `504 SUPPLIER_TIMEOUT` with the booking id and the storefront's "We are confirming your booking" page.
- The worker's reconciliation looks for the order on the OTA's booking queue (Queue List, then a by-reference read of every PNR of the minutes around the request with the lead traveller's name), at most once a minute per booking, and accepts only a PNR with the remark `VELEXIS <reference>` of sub-type BACKOFFICE. Found: the order is recorded, captured and issued as usual. Proven absent by a complete search after `reconcile_until`: the booking `failed`, the authorisation voided, the traveller's `booking.not_confirmed` e-mail and a staff alert. A search left incomplete only by transient failures gets up to 3 more attempts after the deadline (`booking.reconcile_deadline_retry`); any other incomplete search at the deadline goes to the staff (§4.3), never to a void.
- A claim whose process died before the request (no `reconcile_until`) is adopted by the scan after 2 minutes (`booking.reconcile_adopted`) and reconciled the same way.
- Ticketing retries and the booking sync wait for Amadeus on their own schedules ([`ticketing-failures.md`](ticketing-failures.md)).

## 2. Signals

| Signal | Where | Means |
|---|---|---|
| `504 SUPPLIER_TIMEOUT`, `503 SUPPLIER_UNAVAILABLE` on searches and bookings; `424 SUPPLIER_NOT_CONFIGURED` for one OTA; `429 RATE_LIMITED` | Storefront and SDK answers; the OTA admin's shopping page | Amadeus slow or down; one OTA's credentials refused (`reason: credentials_refused`) or connection not active; a token bucket or Amadeus's quota empty |
| `amadeus.call` at level 40 (warning) with `outcome` `timeout`, `server_error` or `network_error`, and its `amadeusOperation`, `officeId`, `status`, `durationMs`, `tenantId` | Journal of `velexis-ota-api` and `velexis-ota-worker` | Every Amadeus call that did not succeed; `client_error` lines are at level 30 |
| `amadeus.credentials_refused`, `amadeus.quota_exceeded`; `amadeus.token_request` with `outcome` `credentials_refused`, `unavailable` or `unexpected_answer` (and its `credId`, `environment`) | Same | A credential set refused by Amadeus (calls answer `424` for 5 minutes without asking again), the quota of a credential set, Amadeus's token endpoint failing |
| `bookings.create_order_timeout`, `bookings.create_order_unreadable` | Journal of `velexis-ota-api` | An order whose outcome is unknown: a reconciliation starts |
| `bookings.reconcile_search_partial` (`gap`), `bookings.reconcile_deadline_retry`, `bookings.reconcile_manual_review`, `bookings.reconcile_airline_card_review`, `bookings.reconcile_not_found`, `bookings.reconcile_found`, `bookings.reconcile_adopted`, `bookings.reconcile_not_scheduled` | Journal of `velexis-ota-worker` (the API for `reconcile_not_scheduled`) | The reconciliation's progress and its decisions |
| `bookings.booking_queue_nearly_full` (`entries`, `limit`); the staff alert whose text says "The booking queue … holds … PNRs" (a `staff.manual_review` about the OTA, not a booking, so its subject is "[Action needed] A payment needs a review") | Journal of the worker; the e-mail, at most once a UTC day per OTA and environment | A booking queue near the 500 PNRs one Queue List answer holds: clean it ([runbook](../../backend/README.md#runbook-cleaning-the-booking-queue)) before searches become incomplete |
| The worker's `queues["ota-maintenance"]` (the per-tenant `bookings.reconcile_scan`, every minute) and `queues["ota-bookings"]` (the `booking.reconcile`, `booking.sync` and `booking.cancellation_check` jobs that the scans queue): `oldestWaitingSeconds` growing, `failedLastHour` above 0; `jobs.job_failed` with `jobName: "bookings.reconcile_scan"`, `bookings.reconcile_job_failed` | `curl -s http://127.0.0.1:4001/health/ready \| jq '.queues \| {"ota-maintenance", "ota-bookings"}'`; the health check's `queue-age-velexis-ota-worker` and `failed-jobs-velexis-ota-worker` e-mails; the worker's journal | Reconciliations, syncs and cancellation checks are not running (worker down or stuck) or keep failing. A scan that works logs nothing at `info` |
| `/health/ready` | Both processes | **Stays `200` during an Amadeus outage**: it checks PostgreSQL and Redis only |
| Dashboard "Outcome unknown (reconciling)"; saved views Reconciling (`status=pending`) and Reconciliation review (`reconcileOutcome=manual_review`) | OTA admin | Bookings waiting for the reconciliation; bookings it handed to the staff |
| Booking page banner "Outcome unknown, reconciling until <time>"; timeline events `booking.supplier_timeout`, `booking.reconcile_adopted`, `booking.reconcile_deadline_retry`, `booking.reconcile_manual_review` (`data.gap`, `code`, `candidates`, `read`; `reason: airline_card_not_found` for an airline card) | OTA admin, `/bookings/<bkg_…>` | One booking's reconciliation |
| The staff alert "[Action needed] Booking … needs a review" | E-mail to the OTA's alert address | A booking left to the staff (§4.3), or one that failed as not found (§4.4) |
| `/supplier-log` filtered by `outcome` or `httpStatus` | OTA admin | The OTA's Amadeus calls, their status, duration and error codes |
| Orphans in the booking queue's read | OTA admin, `/queues/50?officeId=<office>&category=0`, "Read now" | PNRs on the queue that no booking of the OTA owns (§4.5) |

## 3. First checks

1. **Amadeus or Velexis?** If `/health/ready` of the API and the worker is `200` and the failures are `amadeus.call` warnings, the problem is on Amadeus's side or between. If readiness fails, follow [deployment §16](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference) or [README §4](README.md#4-redis-lost-or-restarted-without-its-data) first.
2. **Which calls, which offices, how many?** Count the outcomes of the last 15 minutes by operation:

   ```bash
   journalctl -u velexis-ota-api -u velexis-ota-worker --since -15min -o cat \
     | jq -rR 'fromjson? | select(.msg == "amadeus.call") | [.amadeusOperation, .outcome] | @tsv' | sort | uniq -c | sort -rn
   journalctl -u velexis-ota-api -u velexis-ota-worker --since -15min -o cat \
     | jq -rR 'fromjson? | select(.msg == "amadeus.call" and .outcome != "success") | [.environment, .officeId, .tenantId, .status, .durationMs] | @tsv' | sort | uniq -c | sort -rn | head -20
   ```

   Every office and tenant failing: Amadeus (or the network to it) is down or slow. One office or one OTA failing: its credentials or its office (an OTA on its own credentials, or one shared office).
3. **Ask Amadeus once, as one OTA would** (on the VM; the support check of OBE-025, one cheap search, no personal data, its `supplier_requests` operation `support.amadeusPing`):

   ```bash
   sudo velexis-run ota node dist/cli.js amadeus:ping --tenant <key> --env test
   sudo velexis-run ota node dist/cli.js amadeus:ping --tenant <key> --env live
   ```

   Each step is timed; the last line is `ok`, or the first failed step prints its code (`SUPPLIER_TIMEOUT`, `SUPPLIER_UNAVAILABLE`, `SUPPLIER_NOT_CONFIGURED (credentials_refused)`, `(connection_not_active)`, …) and exits `1`.
4. **Are bookings waiting?** In the OTA admin of each affected OTA and environment, the dashboard's "Outcome unknown (reconciling)" count and the Reconciliation review view. Velexis ops can list them for every OTA from the journal: `journalctl -u velexis-ota-api --since today -o cat | jq -cR 'fromjson? | select((.msg // "") | startswith("bookings.create_order_")) | {time, tenantId, bookingId, msg}'`.
5. **Is the reconciliation running?** The scan runs on `ota-maintenance` and queues its jobs on `ota-bookings`: both answer with a small `oldestWaitingSeconds` (or `null`) in the worker's readiness (§2), `systemctl status velexis-ota-worker` is `active`, and no job of theirs fails: `journalctl -u velexis-ota-worker --since -15min -o cat | jq -cR 'fromjson? | select(.msg == "bookings.reconcile_job_failed" or (.msg == "jobs.job_failed" and .jobName == "bookings.reconcile_scan")) | {time, msg, jobId, attempt, code}'` prints nothing. A working scan writes no log line of its own; a booking still in the Reconciling view more than 5 minutes after the time of its "reconciling until" banner, without a `booking.reconcile_manual_review` event, also says it is not running. If the worker is down: `sudo systemctl restart velexis-ota-worker`; the scans pick every booking up again from PostgreSQL.

## 4. What to do

### 4.1 Amadeus slow or down for everyone

1. Confirm with §3 (several offices, `amadeus:ping` failing in the same step) and check Amadeus's own status information and support channel (level "Provider").
2. Do not restart the API or the worker for it, and do not change a timeout, a bucket or `AMADEUS_BASE_URL_*`: requests fail fast, the reconciliation keeps every unknown order safe, and a restart only adds errors.
3. If it lasts more than 15 minutes, tell the product owner, who decides on a message to the OTAs (searches and bookings fail; bookings already made are safe; a traveller who saw "We are confirming your booking" gets an e-mail either way).
4. While it lasts, the reconciling bookings may reach their deadline with an incomplete search. Transient failures give them up to 3 more attempts, one a minute; after that they go to the staff (§4.3). Expect a few after a long outage.
5. After it: §3 step 2 shows `success` again; within about 20 minutes the Reconciling view (`status=pending`) holds only the bookings that are also in the Reconciliation review view (they stay `pending`, §4.3); work through that view (§4.3).

### 4.2 One OTA or one office failing

- **`424 SUPPLIER_NOT_CONFIGURED`, `credentials_refused`** for an OTA on **its own credentials**: the OTA replaces them in the portal (its Amadeus page); Amadeus refusals are cached 5 minutes (`amadeus:badcred:<credId>`), so the first call after the change may still answer `424`. On **Velexis's shared account**: Velexis ops check the Velexis account in the platform admin's `/amadeus/accounts` (verify it; rotate its secret there, with a step-up, once Amadeus issues new credentials).
- **`connection_not_active`**: the OTA's Amadeus connection of that environment is disabled or has no office: the platform admin's tenant page, Connections tab.
- **`429 RATE_LIMITED`, `amadeus.quota_exceeded`**: one OTA or one credential set uses its buckets up ([architecture §8](../architecture.md#8-rate-limits)). A noisy OTA is limited by its own bucket and does not need an action; a quota that Amadeus itself enforces goes to the Amadeus account manager (level "Provider").
- **One shared office failing** while the others work: Amadeus support, with the office id and the `ama-request-id` of a failed call (`correlationId` of its `amadeus.call` line; the supplier log shows it on every call as the Amadeus request id).

### 4.3 Bookings the reconciliation handed to the staff

The Reconciliation review view (`reconcileOutcome=manual_review`) lists `pending` bookings whose search was still incomplete at the deadline, and airline-card bookings whose order was not found. The booking keeps its checkout (locked) and its authorisation or airline-card payment; the traveller's retries keep answering `504`. Nothing is voided automatically, because the order may exist.

1. **Read why.** The booking's timeline shows `booking.reconcile_manual_review` with `data.gap`:
   - `queue_truncated` (the booking queue holds 500 PNRs or more): clean the queue first ([runbook](../../backend/README.md#runbook-cleaning-the-booking-queue)), never removing PNRs of `pending` bookings or of bookings in review.
   - `read_cap`, `candidate_unreadable`, `order_unreadable`, `lead_unknown`, `queue_failed`, `queue_unreadable`, `read_failed`: the search could not read every candidate.
   - `reason: airline_card_not_found`: an airline-card booking whose order was not found: the airline may still have charged the card.
2. **Look for the order** in the queuing office (the booking's Amadeus office): the console's booking queue (`/queues/50?officeId=<office>&category=0`, "Read now": the queue's PNRs, each with the OTA's booking of its record locator, and the orphans), the Amadeus Selling Platform (the PNRs created around the booking's time with the lead traveller's name), or `/pnr` with a record locator the traveller or the airline gave. The order is the one with the remark `VELEXIS <reference>` of this booking; a name match alone is not enough.
3. **Order found, Stripe payment.** Import it from `/pnr` (it becomes a booking of channel `import` with no payment of its own; `409 ORDER_ALREADY_IMPORTED` means a booking holds it already), capture the original authorisation from the payment's page (`/payments/<pay_…>`, Capture, within the authorisation's 7 days; the dashboard's "Authorised, not captured" lists it), then issue the imported booking from its page (an imported booking needs no payment of its own). Add a note to both bookings naming the other.
4. **Order found, airline card.** Import it the same way; the airline charged the card through the order (Velexis never charges it), so nothing is captured: the imported booking is issued, or was ticketed by the order, as [`ticketing-failures.md`](ticketing-failures.md) §4.3 says for airline-card bookings. Never ask the traveller for the card again, and never type a card number into any Velexis screen.
5. **No order after a complete look.** Nothing was booked. Tell the traveller from the OTA's own mailbox. A Stripe authorisation stays held until Stripe releases it (about 7 days) or until the account holder cancels the PaymentIntent in the Stripe Dashboard: Velexis ops for `velexis` mode, the OTA for its own account; then use "Refresh from Stripe" on the payment page so the payment shows `cancelled`. For an airline card, the OTA's agent asks the airline (or the Amadeus helpdesk) whether a charge exists and has it refunded by the airline.
6. **Add a note** with what was found and done ("Add note" works on a `pending` booking).

**Known limitation of the MVP.** The OTA admin cannot close a `pending` booking: Issue, Cancel and Resync refuse it (`pending`), and no console operation voids an authorisation. A booking settled as above therefore stays `pending` in the Reconciliation review view with its checkout locked; its note says it is settled. Escalate each such booking to Velexis ops (level 2), who keep a list of them until a console action to close a review exists. *2026-11-11 (lead decision (15l), FIX-W48-SHARED):* that action is planned: OBE-099 (the console operation that closes a review, recording a found order on the booking or failing it and releasing the authorisation, with `reconcile_outcome` and the audit trail) and OAD-022 (its OTA admin action), both M6 tasks of [`../plans/agent-tasks.md`](../plans/agent-tasks.md). Until they are done, this limitation and its escalation stand.

### 4.4 Bookings that failed as not found

A Stripe booking whose order was proven absent is `failed` with `failure_code = SUPPLIER_TIMEOUT`, its authorisation voided (`payment.void` on `ota-payments`), the traveller e-mailed (`booking.not_confirmed`), the staff alerted. Nothing to do unless the order turns up later (the airline or the traveller has a record locator, or §4.5 finds it): then import it from `/pnr` and settle the payment with the traveller (the failed booking stays for audit, OADR-0003 point 8); an unticketed, unpaid PNR that nobody imports is cancelled by the airline's own time limit.

### 4.5 Orphan PNRs on the booking queue

The console's read of the booking queue (`/queues/50?officeId=<office>&category=0`, "Read now") marks the PNRs that no booking of the OTA owns. For each one, read the PNR in Amadeus:

- **Remark `VELEXIS <reference>`** names a booking of this OTA that is `failed` (the reconciliation missed the order, §4.4) or `pending` in review (§4.3): settle it as those sections say. Never remove it from the queue before that.
- **No `VELEXIS` remark**: not a Velexis order (another channel of the office); leave it to the office's own procedures.
- **A finished booking's PNR** (confirmed, ticketed, cancelled or failed and settled): remove it from the queue as the [booking queue runbook](../../backend/README.md#runbook-cleaning-the-booking-queue) says, so the queue stays below 400 entries.

On the shared offices the queue is Velexis ops' to clean; an OTA on its own credentials cleans its own.

## 5. Escalation

| When | Who acts | Escalates to |
|---|---|---|
| Searches or bookings fail for every OTA (§4.1) | Velexis ops confirm and watch | Amadeus support (provider level) at once; the product owner after 15 minutes |
| One OTA's own credentials refused or its quota used up | The OTA's staff, in the portal and with Amadeus | Velexis ops when the portal refuses the new credentials |
| A shared office or the Velexis account failing (§4.2) | Velexis ops | Amadeus support with the office id and the `ama-request-id` (`correlationId`) of a failed call |
| The reconciliation is not running (`ota-maintenance` or `ota-bookings` queue age, failed scan or reconcile jobs, §3 step 5) | Velexis ops restart the worker | A bug report with the job reasons and booking ids when the jobs keep failing |
| A booking in Reconciliation review (§4.3) | The OTA's staff look for the order and settle the money | Velexis ops for every settled booking (it stays `pending`), for an authorisation to cancel on Velexis's Stripe account, and for any booking older than 5 days (the authorisation expires after about 7) |
| An airline-card booking not found | The OTA's agent with the airline | Velexis ops if the airline reports a charge that no booking holds |
| The booking queue nearly full | Velexis ops (shared offices), the OTA (own credentials) | — |

## 6. After the incident

Record the window, the offices and OTAs affected, and the bookings that went to review and how each was settled (booking ids only). Check that the Reconciling view holds only bookings that are also in Reconciliation review, and that every booking in Reconciliation review has a note and an owner.
