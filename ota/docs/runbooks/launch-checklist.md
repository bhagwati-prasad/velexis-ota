# OTA launch checklist

The checks that must hold before the OTA group serves live traffic: storefronts in `live`, live Stripe payments, live Amadeus offices. It is the OTA half of the launch; the platform's half is [`platform/docs/runbooks/launch-checklist.md`](../../../platform/docs/runbooks/launch-checklist.md) (PBE-065), checked first. The go/no-go rules come from the [roadmap's M6](../../../docs/mvp/plans/roadmap.md) ("Go/no-go (launch)") and [ADR-0025](../../../docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 4: the launch does not wait for outside approvals, and a feature whose outside step is missing stays off.

**How to use it.** The developer walks through every item on the VM and in the repository at the release that goes live, with the product owner for the items they own, ticks each box (`[x]`) with the date in the last column, and records the walk-through in [§5](#5-walk-through-record) (OBE-089's acceptance criterion: a human step). An item that cannot be ticked is either fixed or recorded in §5 as an open item with its owner; the go/no-go of §4 decides whether the launch waits for it. Every command on the VM (most of §2 and §3) is the developer's; AI agents never run them ([`AGENTS.md`](../../../AGENTS.md) §8). Hosts are the placeholders of [`decisions.md`](../../../docs/mvp/decisions.md#4-placeholder-hosts) §4; use the real ones on the day.

**Owners.** *Developer*: the only person with administrative access to the VM, GitHub and the providers' consoles. *Product owner*: decisions, messages to OTAs and providers, sign-offs.

## 1. Release and quality gates

| # | Item | Owner | Check (command or evidence) | Done |
|---|---|---|---|---|
| A1 | Every task of the OTA and foundation plans is done, except the named exceptions: **OBE-086** (the airline card then stays off, B4), **X-042**, which runs after the launch (lead decision (19h) of 2026-11-12: the launch keeps PostgreSQL and Redis on the VM), and this checklist's own task until the walk-through is recorded | Developer | No other heading without ✅: `for p in ota/docs/plans/agent-tasks.md docs/mvp/plans/foundation-tasks.md; do awk '/^### /{h=$0} /^- \*\*Milestone:\*\*/{ if (h !~ /✅$/) print FILENAME ": " h }' "$p"; done`; and `node tools/plan-lint/plan-lint.mjs` passes | [ ] |
| A2 | No open high finding of the OTA security review | Developer | [`ota/docs/security-review.md`](../security-review.md) §7: every high finding fixed (its follow-up task ✅) or recorded as accepted by the product owner | [ ] |
| A3 | Dependencies audited at the release's commit (PCI DSS 6.3.3, [ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) row 6.3.3) | Developer | `pnpm audit --prod` reports no high or critical issue and `pnpm audit --audit-level high` exits `0`; the open Dependabot pull requests are reviewed; record both outputs' summary lines in §5 | [ ] |
| A4 | Latency and memory budgets met, or their follow-up tasks exist | Developer | [`ota/docs/performance.md`](../performance.md): OBE-088 (API and worker RSS within 768 and 512 MB, `ota-ticketing` and `ota-bookings` latency under 60 s) and OBE-096 (the `flights.search` p95 within 500 ms at 10 visitors in three runs out of three, or the owner's decision with its task) | [ ] |
| A5 | Three consecutive green nightly runs of `storefront`, `storefront-stripe` and `ota-admin` (OFE-026) | Developer | The run links in [`tools/e2e/README.md`](../../../tools/e2e/README.md); `gh run list --workflow e2e.yml --event schedule --limit 3 --json databaseId,conclusion,createdAt` shows three `success`, each with the three projects (`storefront-stripe` runs only when its Stripe test secrets exist). Fewer than three is a no-go (§4) | [ ] |
| A6 | `@velexis/ota-sdk` 1.0.0 is on npm with provenance (SDK-015), and its publication is documented ([OADR-0016](../adr/0016-sdk-packaging-and-type-contract.md) point 8 and follow-ups: the publish workflow, the npm organisation, the IIFE's URL) | Developer | `npm view @velexis/ota-sdk@1.0.0 version` prints `1.0.0`; in an empty folder, `npm install @velexis/ota-sdk@1.0.0 && npm audit signatures` reports a verified attestation; the `sdk-publish.yml` run of the tag `sdk-v1.0.0` is green and its release notes give the IIFE's SRI hash; the versioned CDN URL of the IIFE that [`ota/sdk/README.md` §9](../../sdk/README.md#9-versioning-publishing-and-what-is-deferred) names serves the file with that hash; the sample of [`build-your-own-frontend.md`](../../frontend/docs/build-your-own-frontend.md) runs against the test environment with a `pk_test_` key | [ ] |

## 2. Production configuration (on the VM)

| # | Item | Owner | Check (command or evidence) | Done |
|---|---|---|---|---|
| B1 | The release is deployed and the VM passes its checks | Developer | `sudo velexis-deploy --status` shows the release's sha as current; `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh` prints only `PASS` lines (X-020) | [ ] |
| B2 | Velexis's live Stripe keys are present (`velexis` mode) | Developer | Names and key prefixes only, never a value: `sudo awk -F= '/^STRIPE_(SECRET\|PUBLISHABLE)_KEY_LIVE=\|^STRIPE_WEBHOOK_SECRET_(VELEXIS\|CONNECT)_LIVE=/ { p = index($2, "_live_"); print $1, ($2 == "" ? "EMPTY" : (p ? substr($2, 1, p + 5) "..." : "set")) }' /etc/velexis/ota-backend.env` prints `sk_live_...` (or `rk_live_...`), `pk_live_...` and `set` twice (`CONNECT` may stay `EMPTY` while no OTA uses Connect). The API and the worker refuse a key of the other mode at start-up, so `curl -s http://127.0.0.1:4000/health/ready` and `…:4001/health/ready` answer `200` after the restart | [ ] |
| B3 | The live webhook endpoints exist in Velexis's Stripe account | Developer | In the Dashboard (live mode): `https://api.ota.example.com/webhooks/stripe/velexis/live` with the events of [OADR-0010](../adr/0010-stripe-gateway-and-payment-webhooks.md) point 5 (`payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`), and, for OTAs in `connect_standard` mode, `https://api.ota.example.com/webhooks/stripe/connect/live` listening to the connected accounts' events; each signing secret is the one in the env file (B2). After the first live payment: its deliveries answered `200` and `payments.webhook_stored` in the journal ([`stripe-incidents.md`](stripe-incidents.md) §2) | [ ] |
| B4 | **The airline card stays off** unless OBE-086's gate is fully checked | Developer; the product owner signs a change | `sudo grep -c '^AIRLINE_CARD_ENABLED=false$' /etc/velexis/ota-backend.env` prints `1`, unless every item of [`airline-card-go-live.md`](airline-card-go-live.md) is checked with its evidence (the penetration test and ASV scan, the open PCI controls, lead decision 12e of 2026-11-10: off while the only developer is away). A live storefront offers no airline card: `curl -s https://<key>.ota.example.com/api/v1/storefront \| jq -c '[.. \| objects \| .supportedMethods? // empty]'` lists no `airline_card` | [ ] |
| B5 | The booking queue is confirmed for every Velexis shared office | Developer, with Amadeus | For each office of the platform admin's `/amadeus/offices` (test and live): Amadeus confirmed in writing that orders created with `automatedProcess` code `IMMEDIATE` are queued on queue 50, category 0 of the queuing office, and the largest `max` Queue List accepts ([OADR-0003](../adr/0003-booking-orchestration-and-supplier-timeout-recovery.md) follow-ups); record the date in §5. A test order on each test office shows in the OTA admin's `/queues/50?officeId=<office>&category=0` ("Read now") with its booking linked. Every OTA on those offices has queue 50 / category 0 in console Settings → Storefront → Operations; an OTA on its own credentials has its own booking queue set there, or knows that without one a booking whose answer was lost cannot be looked for: its Stripe authorisation is voided after 15 minutes and its staff are told to check the office by hand | [ ] |
| B6 | Live Amadeus answers for every OTA that goes live | Developer | `sudo velexis-run ota node dist/cli.js amadeus:ping --tenant <key> --env live` ends with `ok` for each | [ ] |
| B7 | Alerts reach a person | Developer | `sudo grep -hE '^(OPS_ALERT_EMAIL\|ALERT_TO)=' /etc/velexis/ota-backend.env /etc/velexis/alert.env` names one monitored mailbox; `echo "OTA launch checklist B7" \| sudo /usr/local/sbin/velexis-alert message "alert test"` arrives there; every live OTA has an alert address (console Settings → Storefront → Operations) or owners who read their mail | [ ] |
| B8 | Someone owns the cleaning of the shared offices' booking queues | Product owner names them | The name in §5; they follow the [booking queue runbook](../../backend/README.md#runbook-cleaning-the-booking-queue) and look at the queue view weekly | [ ] |

## 3. Monitoring, backups and recovery

The foundation's M6 outcome of the roadmap's go/no-go. Each task's acceptance is checked in its own plan; here the developer confirms that it holds on the production VM today.

| # | Item | Owner | Check (command or evidence) | Done |
|---|---|---|---|---|
| C1 | External uptime monitoring alerts (X-029) | Developer | X-029 ✅; its four monitors green; `curl -fsS https://api.ota.example.com/health/live` from outside the VM answers `{"status":"ok"}`; [deployment §13](../../../docs/mvp/deployment-single-vm.md#13-monitoring-and-uptime) names the monitors and the recipients | [ ] |
| C2 | The on-VM health check alerts (X-030) | Developer | X-030 ✅ (its VM check: one alert and one recovery for a stopped worker); `sudo velexis-healthcheck --status` shows every check `ok`; `sudo velexis-healthcheck --payment-pages` passes | [ ] |
| C3 | Backups leave the VM every night (X-024) | Developer | X-024 ✅; `backup-age` is `ok` in the status above; the last set is in the bucket and `rclone check` passes ([deployment §10](../../../docs/mvp/deployment-single-vm.md#10-backups) step 5). Failing backups are a no-go | [ ] |
| C4 | The restore drill is done with its RTO (X-031) | Developer | X-031 ✅ with an RTO of 4 hours or less in [`docs/mvp/runbooks/restore-drill.md`](../../../docs/mvp/runbooks/restore-drill.md) (X-031 writes it) and `/var/log/velexis/restore-drill-<date>.log`; the drill recorded in [§6](#6-restore-drill-record) as [deployment §11](../../../docs/mvp/deployment-single-vm.md#11-restore-and-the-restore-drill) asks. A failed drill is a no-go | [ ] |
| C5 | The rest of the foundation's outcome: the move to managed services is configuration only (X-032), SSH needs a second factor (X-037), security logs leave the VM with a daily review (X-038), the web application firewall is in front of the public hosts (X-039) | Developer | Each heading ✅ in [`docs/mvp/plans/foundation-tasks.md`](../../../docs/mvp/plans/foundation-tasks.md) (A1's command lists the open ones) | [ ] |

## 4. Operations readiness and the decision

| # | Item | Owner | Check (command or evidence) | Done |
|---|---|---|---|---|
| D1 | The runbooks work on the VM | Developer | Read every runbook of this folder ([`README.md`](README.md)) and run its read-only commands once on the VM: both `/health/ready` answers, `sudo velexis-healthcheck --status`, the journal's `jq` lines, `sudo velexis-run ota node dist/cli.js amadeus:ping --tenant <key> --env test`, the deploy log and the last fan-out report of [`tenant-migration-failures.md`](tenant-migration-failures.md) §3, `check-vm.sh --only services,redis`. Fix a runbook whose command does not work | [ ] |
| D2 | The platform's launch checklist is checked | Developer and product owner | [`platform/docs/runbooks/launch-checklist.md`](../../../platform/docs/runbooks/launch-checklist.md) (PBE-065): live billing, Connect, the live Velexis Amadeus account and offices, the switches, `OPS_ALERT_EMAIL`, the legal sign-off | [ ] |
| D3 | Go or no-go | Product owner, with the developer | **Go** when A1 to D2 are ticked, or every open item is recorded in §5 with its owner and the product owner accepts it, and the product owner has accepted the known limitations the runbooks record (since OBE-099, lead decision (15l) of 2026-11-11, a booking in Reconciliation review is closed with console.bookings.closeReview, [`supplier-timeout-and-reconciliation.md`](supplier-timeout-and-reconciliation.md) §4.3, as [OADR-0003](../adr/0003-booking-orchestration-and-supplier-timeout-recovery.md)'s follow-up asks; it is no longer one of them). **No-go** while any of these holds: an open high finding (A2), a failed restore drill (C4), fewer than three consecutive green nightly runs (A5), failing backups (C3). Live tenants wait for live Amadeus access, and the airline card for B4 | [ ] |

## 5. Walk-through record

The developer's walk-through of this checklist, on the VM, at the release that goes live (OBE-089, acceptance: a human step). Add a row per walk-through; a walk-through that leaves open items is repeated after they are closed.

| Date | By | Release (sha) | Items ticked | Open items, owners, and the audit lines of A3 | Decision (D3) |
|---|---|---|---|---|---|
| — | The developer | — | — | — | Pending |

Records the items ask for:

| Item | Record |
|---|---|
| B5: Amadeus's confirmation of the booking queue, per office | — |
| B8: who cleans the shared offices' booking queues | — |

## 6. Restore drill record

[Deployment §11](../../../docs/mvp/deployment-single-vm.md#11-restore-and-the-restore-drill) asks for the drill's date, duration and result here as well as in its log.

| Date | Set (`daily/<date>`) | RTO (provisioning to the checks) | Figures against the MANIFEST | Log | Result |
|---|---|---|---|---|---|
| — | — | — | — | — | Pending (X-031) |
