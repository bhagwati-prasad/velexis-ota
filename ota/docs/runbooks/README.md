# OTA operations runbooks

What to do when something goes wrong in the OTA group (the OTA API and worker, the hosted storefront, the OTA admin), and the checklist for the launch. Each runbook names the **signals** that show the problem (log lines, `/health/ready`, the health check's e-mails, the OTA admin's views, the staff alerts), the **commands** that confirm it and fix it, and the **escalation**: who takes over when the first person cannot finish it. Task OBE-089 wrote them; the incident classes are those of [architecture §10](../architecture.md#10-failure-behaviour) that need a person.

They are human procedures. The shell commands are run on the VM by the developer, the only person with administrative access to it ([`pci/incident-response.md`](../pci/incident-response.md#1-roles-and-contacts)); AI agents never run them ([`AGENTS.md`](../../../AGENTS.md#8-security-rules-never-broken) §8: no production access). The steps in the OTA admin are for the OTA's staff or for Velexis ops. Hosts are the placeholders of [`decisions.md`](../../../docs/mvp/decisions.md#4-placeholder-hosts) §4: read `api.ota.example.com` as the real OTA API host, and so on.

Related: [deployment-single-vm.md §16](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference) (the VM's incident quick reference: Caddy, units, disk, backups, certificates, SSH), [`pci/incident-response.md`](../pci/incident-response.md) (anything that may touch card data or the VM's integrity), the platform's runbooks of PBE-065 ([`platform-operations.md`](../../../platform/docs/runbooks/platform-operations.md), [`launch-checklist.md`](../../../platform/docs/runbooks/launch-checklist.md)).

## 1. The runbooks

| Incident class | Runbook | First signal |
|---|---|---|
| Amadeus slow or down; bookings whose order may exist (`504 SUPPLIER_TIMEOUT`) and their reconciliation; bookings the reconciliation hands to the staff; orphan PNRs on the booking queue | [`supplier-timeout-and-reconciliation.md`](supplier-timeout-and-reconciliation.md) | `amadeus.call` warnings in the journal; the console's "Outcome unknown (reconciling)" and "Reconciliation review" views; the staff alert "Booking … needs a review" |
| Ticketing given up; tickets that keep failing; airline-card bookings in manual review | [`ticketing-failures.md`](ticketing-failures.md) | The staff alert "Ticketing failed for booking …"; the console's "Ticketing problems" view; `bookings.ticketing_given_up` |
| Stripe down or slow; a webhook backlog; captures, voids and refunds that fail; authorisations about to expire; disputes | [`stripe-incidents.md`](stripe-incidents.md) | `502 PAYMENT_PROVIDER_ERROR`; failed deliveries in the Stripe Dashboard; the worker's `ota-stripe-events` and `ota-payments` queues |
| Tenant schemas that fail to migrate in the deploy's fan-out, or in a `tenant.migrate` job | [`tenant-migration-failures.md`](tenant-migration-failures.md) | The Deploy workflow's log; the platform's `tenant.migration_failed` ops alert |
| Redis lost or restarted without its data (staff sign in again) | [§4](#4-redis-lost-or-restarted-without-its-data) below | `/health/ready` answering `503` with `checks.redis`; staff sent back to the portal |
| The OTA API's JWT signing key (`ota-jwt-ed25519.pem`) possibly exposed, or due for a planned rotation, with the overlap of one token lifetime (`JWT_PREVIOUS_PUBLIC_KEY_FILE`, FIX-W48-OTA) | [`jwt-key-rotation.md`](jwt-key-rotation.md) | A suspected exposure of the VM, the `velexis-ota` user or a copy of `/etc/velexis` ([incident response plan](../pci/incident-response.md)); someone who had root leaves |
| Launch | [`launch-checklist.md`](launch-checklist.md) | Every item checked, the walk-through recorded with its date |
| Live airline-card payments | [`airline-card-go-live.md`](airline-card-go-live.md) (OBE-086): the gate that must be fully checked before `AIRLINE_CARD_ENABLED=true` | — |

Other runbooks the OTA group relies on:

| Runbook | For |
|---|---|
| [Cleaning the booking queue](../../backend/README.md#runbook-cleaning-the-booking-queue) (backend README §4) | The booking queue that nears the 500 PNRs one Queue List answer holds (the staff alert "[Action needed] A payment needs a review" whose text says "The booking queue … holds … PNRs") |
| [Incident quick reference](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference) (deployment §16) | Everything public down, one app on the maintenance page, both APIs answering `503`, a storefront host without a certificate, the backup and health check alerts, disk above 80 %, SSH |
| [PCI incident response plan](../pci/incident-response.md) | A payment page alert, card data where it must not be, a card-testing attack, a suspected intruder: severity, containment (the airline card off), notifications |
| [Master-key rotation](../../../docs/mvp/runbooks/master-key-rotation.md), [SSH access](../../../docs/mvp/runbooks/ssh-access.md) | The master key after a suspected compromise; the admin's SSH second factor, lost keys, break-glass |
| The platform's runbooks (PBE-065): [`platform-operations.md`](../../../platform/docs/runbooks/platform-operations.md) | A stuck provisioning job, a failed billing Stripe event, a lost authenticator of an owner, key rotations |

## 2. Where the signals are

The same few places answer most questions. Each runbook says which of them to read first.

**Health of the processes (on the VM).** Caddy answers `404` to `/health/*` from outside except `/health/live`, so readiness is read on the VM itself:

```bash
curl -s http://127.0.0.1:4000/health/ready | jq            # OTA API: {"status":"ok","checks":{"postgres":"ok","redis":"ok"}}
curl -s http://127.0.0.1:4001/health/ready | jq            # OTA worker: the same, plus "queues"
curl -s http://127.0.0.1:4001/health/ready | jq '.queues'  # per queue: waiting, oldestWaitingSeconds, failedLastHour
sudo /usr/local/sbin/velexis-healthcheck --status          # the last state of every on-VM check, since when, first problem
```

`/health/ready` answers `503` with `status: "unavailable"` when PostgreSQL or Redis does not answer within 2 s (`checks.postgres`, `checks.redis`: `timeout` or `down`). It does **not** check Amadeus, Stripe or SMTP: an outage of a provider leaves both processes ready, and its signals are the log lines and the console views of the runbooks. The worker's `queues` part never makes it unready; it is absent while Redis does not answer the queue report within 1 s ([`queue-age.ts`](../../backend/src/health/queue-age.ts)). The on-VM health check ([deployment §13](../../../docs/mvp/deployment-single-vm.md#13-monitoring-and-uptime)) turns these into e-mails, one when a check fails and one when it recovers. The runbooks name the checks by their id: `ready-velexis-ota-api`, `ready-velexis-ota-worker`, `failed-jobs-velexis-ota-worker` (more than 20 failed jobs in the last hour, over all the worker's queues), `queue-age-velexis-ota-worker` (a job waiting more than 10 minutes), `redis-memory`, `disk-*`, `backup-age`, `tls-*` and the payment pages. An e-mail's subject names the check's label, `[velexis][<host label>] health check failed: <label>: <first problem>` (for example `velexis-ota-api readiness`, `failed jobs of velexis-ota-worker`, `waiting jobs of velexis-ota-worker`, `Redis memory`), and its body the id (`Check: ready-velexis-ota-api`).

**From outside the VM.** The external uptime monitor (X-029, [deployment §13](../../../docs/mvp/deployment-single-vm.md#the-external-uptime-monitor)) asks for `https://api.ota.example.com/health/live` and the demo storefront's home page once a minute and sends a down notice, then a recovery notice, to the operations mailbox and the developer's phone. A storefront's pages are static, so its monitor stays up while the OTA API is down; the OTA API's monitor is the one that alerts. By hand: `curl -fsS https://api.ota.example.com/health/live` answers `{"status":"ok"}`, and `503` with `SERVICE_UNAVAILABLE` means Caddy answers but the OTA API does not.

**Logs (on the VM).** Both processes write one JSON line per event to journald (pino: the event's name in `msg`, `level` 40 for a warning and 50 for an error, ids and codes, never a body, a token or card data). `jq -R 'fromjson? | …'` skips the lines that are not JSON:

```bash
journalctl -u velexis-ota-api -u velexis-ota-worker --since -1h -o cat | jq -cR 'fromjson? | select(.level >= 40) | {time, msg, tenantId, bookingId, code}'
journalctl -u velexis-ota-worker --since -1h -o cat | jq -cR 'fromjson? | select(.msg == "bookings.ticketing_given_up")'
journalctl -u velexis-ota-api --since -1h -o cat | jq -cR 'fromjson? | select(.requestId == "<id>")'   # the request id of an error answer
```

Never paste log lines into tickets or chats: the request id, the booking id (`bkg_…`) and the event name are enough ([deployment §12](../../../docs/mvp/deployment-single-vm.md#12-logs)).

**The OTA admin** (`https://admin.ota.example.com`, the OTA's staff after "Open console" in the portal; [route map](../../admin/README.md#5-route-map)). Choose TEST or LIVE in the header first: every view shows one environment.

| View | Shows |
|---|---|
| `/` dashboard | The needs-attention counts: "Ticketing failed or in manual review", "Ticketing deadline within 24 h", "Outcome unknown (reconciling)"; "Authorised, not captured" payments; the last queue read |
| `/bookings` saved views | Ticketing problems (`ticketingStatus=failed,manual_review`), Reconciliation review (`reconcileOutcome=manual_review`), Deadline within 24 h, Cancellation requested, Schedule changed; Reconciling (`status=pending`), To issue ([routes §3.1](../../admin/docs/routes.md#31-list-bookings)) |
| `/bookings/<bkg_…>` | What needs staff above the tabs (a banner per state), the timeline with the staff-only events (`booking.supplier_timeout`, `booking.reconcile_manual_review`, `booking.ticketing_failed`, …), the Amadeus order, the payments; the actions Issue, Cancel, Resync, Add note |
| `/payments` (`?status=authorized`), `/payments/<pay_…>` | Payments by status; one payment's events and refunds, Capture, Refund, "Refresh from Stripe" |
| `/queues`, `/queues/<n>?officeId=…&category=…` | The stored queue reads; "Read now" lists a queue's PNRs with each one's booking, and marks the orphans |
| `/pnr` | PNR lookup by record locator and import of an order Velexis did not record |
| `/supplier-log` | Every Amadeus call of the environment: operation, HTTP status, outcome, duration, error codes, booking (bodies redacted, on demand) |

**The platform admin** (`https://admin.platform.example.com`, Velexis's platform admins): `/queues` (counts for every queue of both backends) and `/queues/<queue>` (failed jobs with their reasons and id-only payloads; only the platform's queues can be retried there), `/tenants/<id>` (status, schema version, the Migrate action, the audit tab), `/provisioning-jobs` (provisioning, migrate, suspend and resume jobs with their steps and errors).

**Staff alerts** are e-mails from the OTA worker to the OTA's `ops_alert_email` (console Settings → Storefront → Operations), else to its owners, else to Velexis ops (`OPS_ALERT_EMAIL` of `/etc/velexis/ota-backend.env`; [`staff-recipients.ts`](../../backend/src/notifications/staff-recipients.ts)): `staff.manual_review` ("[Action needed] Booking … needs a review", or "A payment needs a review"), `staff.ticketing_failed` ("[Action needed] Ticketing failed for booking …") and `staff.airline_card_alert` ("[Alert] Airline-card payments: …").

## 3. Escalation

Every runbook ends with its own escalation table; they all use these levels.

| Level | Who | Takes | How they are reached |
|---|---|---|---|
| 1 | **The OTA's staff** (owner, admin, agent; finance for payments) | Everything one booking or payment needs that the OTA admin offers: issue, cancel, resync, capture, refund, PNR import, notes; contact with their travellers and, for an OTA with its own Amadeus or Stripe account, with that provider | The staff alerts; the OTA admin |
| 2 | **Velexis ops: the developer** | Everything on the VM (units, Redis, PostgreSQL, deploys, the CLI commands run with `velexis-run`), the shared Amadeus offices and their booking queues, Velexis's own Stripe account (`velexis` mode), and what the OTA admin cannot do | The health check and unit e-mails (`ALERT_TO` of `alert.env`), the external uptime monitor (X-029), `OPS_ALERT_EMAIL`; the OTAs write to the same operations mailbox |
| 3 | **The product owner** | Every message to OTAs about an outage or an incident, the decision to keep a feature off, escalations to a provider's management | The developer, through the channel kept with the contacts of the [incident response plan](../pci/incident-response.md#1-roles-and-contacts) |
| Provider | **Amadeus** (the support channel of Velexis's contract; the account manager), **Stripe** (support from the Dashboard of the account that holds the payment), **the airline** (through the OTA's agents or the Amadeus helpdesk) | Their own outage, a refused ticket or card, a quota | Where the [incident response plan §1](../pci/incident-response.md#1-roles-and-contacts) keeps their contacts; never in this repository |
| Security | **The incident lead** of the [incident response plan](../pci/incident-response.md) | Anything that may expose card data or show an intruder: a payment page alert outside a deploy, card data in a log or a table, a card-testing attack, an unknown key or login | Severity 1 within the hour ([§2 there](../pci/incident-response.md#2-what-counts-as-an-incident-and-how-serious-it-is)) |

Escalate from level 1 to level 2 when a runbook says so, when the OTA admin answers with an error that its message does not explain (send the request id), and when more than one booking fails the same way. Escalate to level 3 when travellers or OTAs must be told, or when a provider must be pushed. When a step could expose card data, stop and follow the incident response plan.

## 4. Redis lost or restarted without its data

Redis holds the job queues, caches, counters and the staff sessions; PostgreSQL holds every durable record ([deployment §5](../../../docs/mvp/deployment-single-vm.md#5-postgresql-and-redis), [architecture §7](../architecture.md#7-redis-keys)). It writes its append-only file every second, so a plain restart loses at most about a second of writes. This section is for Redis down, and for Redis back without its data (a damaged or missing append-only file, a disk replaced, a restore of the VM without the `redis` step).

### Signals

| Signal | Where |
|---|---|
| Both OTA processes answer `/health/ready` with `503` and `checks.redis` `down` or `timeout`; the worker's answer has no `queues` | `curl -s http://127.0.0.1:4000/health/ready`, `…:4001/health/ready`; the health check's `ready-velexis-ota-api` and `ready-velexis-ota-worker` e-mails (subject `health check failed: velexis-ota-api readiness: …`), and those of the platform's units |
| `redis.connection_error` once per outage and connection, `redis.connection_restored` after it; `health.dependency_unavailable` with `dependency: "redis"`; `throttler.store_unavailable`; `payments.webhook_enqueue_failed` or `_timeout` | `journalctl -u velexis-ota-api -u velexis-ota-worker --since -1h -o cat \| jq -cR 'fromjson? \| select((.msg // "") \| test("^redis\\.\|dependency_unavailable\|store_unavailable\|webhook_enqueue"))'` |
| Staff are sent back to the portal from the OTA admin (their refresh families `staffsess:*` are gone, so the refresh is refused) and must click "Open console" again | Staff reports; the OTA admin answers no error, only the portal |
| While Redis is down, every rate-limited operation answers `503 SERVICE_UNAVAILABLE`, because its limit cannot be counted and is never skipped ([`rate-limits.ts`](../../backend/src/common/http/rate-limits.ts)): the storefront's searches, upsells and prices (edge and publishable keys), `checkout.createPayment` and `checkout.complete`, the customers' sign-in, sign-up and password reset, the airline-card completion, the public downloads, and every console operation, so the OTA admin is unusable as well; every Amadeus call of any caller answers `503` too (its buckets and token cache are in Redis: a secret key's searches, `bookings.get` with `refresh: true`, cancellations; [architecture §10](../architecture.md#10-failure-behaviour), note of 2026-11-11); Stripe webhook deliveries answer `503` and Stripe sends them again; no job runs | The storefront and the OTA admin; failed deliveries in the Stripe Dashboard; the worker's queues |
| Redis started without its data: its log says the append-only file could not be loaded or was missing; the platform admin's `/queues` shows every queue nearly empty, completed and failed jobs included | `journalctl -u redis-server -b --no-pager \| tail -n 50` |
| Redis refuses writes (`OOM command not allowed`, `maxmemory` 512 MB with `noeviction`) | The health check's `redis-memory` e-mail (subject `health check failed: Redis memory: …`); the worker's jobs failing |

### Commands

```bash
systemctl status redis-server --no-pager
journalctl -u redis-server -n 100 --no-pager
sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only services,redis   # read-only: running, loopback only, password, maxmemory, AOF
sudo ls -la /var/lib/redis/appendonlydir                                         # the append-only files and their manifest
sudo systemctl restart redis-server                                              # Redis down: start it again (it reloads its AOF)
sudo systemctl restart velexis-ota-worker                                        # after a loss: the worker declares its schedulers again
journalctl -u velexis-ota-worker -n 200 -o cat | jq -cR 'fromjson? | select(.msg == "scheduler.registered" or .msg == "scheduler.registration_failed")'
```

### What to do

1. **Redis down.** Restart it (`sudo systemctl restart redis-server`) and check both readiness answers. It reloads its append-only file: queues, sessions and counters come back, and the processes reconnect by themselves (`redis.connection_restored`). If it does not start, read its journal: a full disk is [deployment §16](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference)'s disk row; a damaged append-only file is step 3.
2. **Redis full** (`redis-memory` above 70 % of `maxmemory`, or writes refused). Look at the platform admin's `/queues` for a queue that grows (a worker that is down, a notifications backlog while SMTP is down) and fix its cause first; failed jobs are kept 30 days by design. Raising `maxmemory` is [deployment §14](../../../docs/mvp/deployment-single-vm.md#14-capacity-limits-of-one-vm)'s remedy: a change of [`deploy/redis/velexis.conf`](../../../deploy/redis/velexis.conf) in the repository, applied with `provision-vm.sh --steps redis` of the release that has it, never a manual edit of `/etc/redis/velexis.conf` alone.
3. **Redis back without its data.** Do not flush or delete anything. Copy the damaged folder aside first (`sudo cp -a /var/lib/redis/appendonlydir /root/redis-aof-$(date -u +%Y%m%dT%H%M%SZ)`), then choose:
   - **Start empty** (the default when the loss is found within the day): nothing durable is lost. Restart **both workers** at once (`sudo systemctl restart velexis-ota-worker velexis-platform-worker`): each declares its schedulers only when it starts (`scheduler.registered` lists them). Then the scans and sweeps, which read PostgreSQL, rebuild the lost jobs: `bookings.reconcile_scan` (reconciliations and lost cancellation checks, every minute), `ticketing.scan` (5 minutes), `notifications.sweep` (the outbox, every minute), `refunds.sweep` (5 minutes), `bookings.sync_scan` (10 minutes); the platform's provisioning reconciler re-dispatches its tenant jobs.
   - **Restore last night's copy** with `velexis-restore redis` (after `velexis-restore fetch`, [deployment §11](../../../docs/mvp/deployment-single-vm.md#11-restore-and-the-restore-drill); it asks for the hostname and stops Redis briefly): it brings back the jobs and the failed-job history of 02:30. A job that already ran since then runs again and does nothing, because every job reads its row first and stops when the state moved ([ADR-0009](../../../docs/mvp/adr/0009-background-jobs-bullmq.md)). Then restart both workers as above. It also brings back the sessions and revocations of 02:30: a staff session that was signed out, revoked for a reused refresh token or ended by the portal's "sign out everywhere" since then works again until its 12 hours end (a removed or suspended member stays refused, as that is read from the platform). So restore only when nothing was revoked since 02:30 for a security reason; otherwise start empty, which ends every staff session.
4. **What nothing rebuilds**, to check after a loss (start empty or restore alike):
   - **Staff sessions and portal tokens**: staff click "Open console" in the portal again. Revocations (`staffdeny:*`) are gone with the sessions they refused; an access token of a lost session is refused at once, because every console request checks that its session still exists.
   - **Stripe events whose job was lost** after the receiver answered `200`: in the Stripe Dashboard, resend the endpoint's events of the window (a repeated delivery queues the job again, without a second `payment_events` row), or open each payment of the window in the OTA admin and use "Refresh from Stripe" ([`stripe-incidents.md`](stripe-incidents.md) §4.2).
   - **Voids and capture retries** (`payment.void`, `payment.capture_retry`) that were waiting: in the OTA admin, `/payments?status=authorized` of each environment lists the authorisations still held; capture those of confirmed bookings (or issue the booking, which captures first) and release the others as [`stripe-incidents.md`](stripe-incidents.md) §4.1 says.
   - **Documents** whose rendering job was lost: the booking keeps its earlier documents until its next event asks for new ones; e-mails waiting for them go out after 2 minutes without attachments, with the link to the booking page.
   - **Counters and flags**: rate limits, sign-in lockouts, the airline-card attempts of a checkout and an OTA's one-hour airline-card suspension after 20 declines. If a card-testing attack was going on, follow the [incident response plan §4.4](../pci/incident-response.md#44-a-card-testing-attack) and turn the airline card off.
   - **The deploy's tenant migration report** of a deploy that ran in the window: deploy the same release again ([`tenant-migration-failures.md`](tenant-migration-failures.md) §4.3).
5. Check the health check is all `ok` again (`sudo velexis-healthcheck --status`) and record what happened (the window, the choice of step 3, the payments and events handled).

### Escalation

| When | To |
|---|---|
| Redis down or full | Velexis ops (the developer) at once: meanwhile the OTA API refuses searches, payments, sign-ins, every console call and the webhooks (`503`), and the product owner decides on a message to the OTAs after 15 minutes |
| Redis restarted without its data | Velexis ops; the product owner tells the OTAs that their staff must open the console again |
| A restore is considered | The developer decides; the age private key comes to the VM only for the restore and is shredded afterwards (deployment §11) |
| A card-testing attack was running when the counters were lost | The incident lead ([incident response plan](../pci/incident-response.md)) |

## 5. Keeping the runbooks true

The runbooks name log events, console views and commands of the code as it was on commit `f8c3c8b`. A task that renames a log event, a view or a command, or changes what an operator must do, changes the runbook in the same pull request, as the [conventions](../../../docs/mvp/conventions.md) ask of every document a change makes stale. The developer walks through the launch checklist on the VM and runs the read-only commands of each runbook once ([`launch-checklist.md`](launch-checklist.md) item D1); a command that does not work there is fixed here. After an incident, write what happened and what changes within two weeks, and correct the runbook that did not hold.
