# Platform launch checklist

What must be true before the Velexis platform (portal, platform admin, platform API and worker) takes its first real OTA: Stripe in live mode with the platform's two webhook endpoints, the Customer Portal and the Connect settings; the first platform admin; the live Velexis Amadeus account and its offices; the operations mailbox; the legal sign-off of Velexis-collected payments; and the order in which the six milestone switches of [PADR-0015](../adr/0015-milestone-feature-switches.md) are turned on. Every item names its owner and the check that proves it. Task PBE-065 of [`../plans/agent-tasks.md`](../plans/agent-tasks.md) wrote it; the roadmap's M6 gate has the developer walk through it on the VM ([`roadmap.md`](../../../docs/mvp/plans/roadmap.md), M6 "Human review gates"), and the launch go/no-go is the product owner's.

Related: [`platform-operations.md`](platform-operations.md) (what to do when something goes wrong after the launch); the OTA's own launch checklist `ota/docs/runbooks/launch-checklist.md` (task OBE-089) and the airline-card go-live checklist `ota/docs/runbooks/airline-card-go-live.md` (task OBE-086), walked through with this one; [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) (the VM, its env files, health checks and incident quick reference); [`../flows/subscription-billing.md`](../flows/subscription-billing.md), [`../flows/stripe-payments-account.md`](../flows/stripe-payments-account.md), [`../flows/amadeus-connection.md`](../flows/amadeus-connection.md), [`../flows/custom-domains.md`](../flows/custom-domains.md).

It is a human procedure in the providers' dashboards, the platform admin and on the VM. AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8: no production access).

## 1. How to use it

- **Hosts.** The Velexis hosts below are the placeholders of [`decisions.md`](../../../docs/mvp/decisions.md) §4: `platform.example.com` (portal), `admin.platform.example.com` (platform admin), `api.platform.example.com` (platform API), `<key>.ota.example.com` (a hosted storefront), `api.ota.example.com` (OTA API); a custom storefront domain is written `<custom-domain>`. On the VM they are the real hosts of `/etc/velexis/*.env` and `caddy.env`. Stripe and Amadeus hosts are the providers' own.
- **Owners.** **Developer**: the only person with administrative access to the VM, the platform admin and the technical settings of the providers' dashboards; runs every command. **Product owner**: holds the contracts with Stripe and Amadeus and the business settings of their dashboards, sets prices, approves legal texts, engages legal counsel and decides the go/no-go of the launch. An item with two names has its accountable owner first.
- **Each item** says what to do, its **Owner**, its **Check** (a command, a page or a document that proves it) and its **Evidence** in the repository: the code or test that makes the check meaningful.
- **Commands** run on the VM as the admin user with `sudo`. Env files are `root:root 0600`: edit them with `sudoedit`, never with a secret on a command line, and never paste a secret into a ticket. Every command here prints names, counts or values that are not secret (e-mail addresses, ids, HTTP status codes).
- **Walk-through.** Copy the boxes into the launch issue and tick them there, each with the date and what its check showed (no secret). The boxes in this file stay empty: it is the template, also for a rebuilt VM. Record each walk-through in [§8](#8-record).
- **Escalation.** A failing check stops its item. The developer fixes the cause with [`platform-operations.md`](platform-operations.md) or the [incident quick reference](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference); the product owner decides whether the launch waits for it.

## 2. Before you start

- [ ] **The release is deployed and the VM is healthy.**
  - Do: deploy the launch release with the Deploy workflow ([deployment §8](../../../docs/mvp/deployment-single-vm.md#8-release-artefact-deploy-and-rollback)).
  - Owner: developer.
  - Check: `sudo velexis-deploy --status` names the release's sha; `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh` prints only `PASS` lines; `sudo velexis-healthcheck --status` shows every check `ok` (the payment page checks only once the production demo OTA of [§6](#6-manual-trials-before-billing) exists: they fetch its storefront).
  - Evidence: `deploy/scripts/check-vm.sh` and `deploy/scripts/healthcheck.sh`, tested by `deploy/scripts/test/check-vm.test.sh` and `deploy/scripts/test/healthcheck.test.sh`.
- [ ] **Every milestone switch is off.**
  - Do: the six `FEATURE_*` variables are `false` in `/etc/velexis/platform-backend.env`; `/etc/velexis/platform-worker.env` sets none of them, so the worker's schedulers and the API's endpoints of a feature are on or off together.
  - Owner: developer.
  - Check: `sudo grep -sH '^FEATURE_' /etc/velexis/platform-backend.env /etc/velexis/platform-worker.env` prints six `=false` lines, all of `platform-backend.env`.
  - Evidence: `platform/backend/src/config.ts` (every switch defaults to `false`), `deploy/env/platform-worker.env.example`.
- [ ] **The OTA launch checklist is walked through with this one.**
  - Do: `ota/docs/runbooks/launch-checklist.md` (OBE-089) covers what the OTA API needs for the same launch: Velexis's live Stripe keys and the OTA API's payment webhook endpoints, the booking queue of every shared office, the SDK, the nightly suites, monitoring (X-029, X-030) and the restore drill (X-031). The airline card stays off unless `ota/docs/runbooks/airline-card-go-live.md` (OBE-086) is done (lead decision 12e of 2026-11-10).
  - Owner: developer.
  - Check: both checklists' records (§8 here, the OTA checklist's own) carry the same walk-through date, and neither has an open item without an owner.
  - Evidence: [`roadmap.md`](../../../docs/mvp/plans/roadmap.md) M6 (both checklists are walked through on the VM).
- [ ] **Two-step authentication on the providers' accounts.**
  - Do: every user of Velexis's Stripe Dashboard has two-step authentication, and so has every user of the other provider accounts the PCI pack names: GitHub, the cloud console, DNS, the backup bucket and the SMTP account. Nobody shares a login. The PCI pack lists MFA on the provider accounts as an open human step (8.4.2, 8.4.3); the airline-card go-live checklist (OBE-086) lists it too, but the launch does not wait for that one.
  - Owner: developer, with the product owner (the holder of the Stripe account).
  - Check: Stripe's team settings show two-step authentication for every member, and each other provider's security settings show it for every user; recorded in the launch issue, provider by provider.
  - Evidence: [`ota/docs/pci/responsibility-matrix.md`](../../../ota/docs/pci/responsibility-matrix.md), requirement 8 ("MFA on the provider accounts").

## 3. Operations mailbox and the first platform admin

- [ ] **`OPS_ALERT_EMAIL` reaches the operations mailbox.**
  - Do: in `/etc/velexis/platform-backend.env` set `OPS_ALERT_EMAIL` to the Velexis operations mailbox, never the template's `CHANGE_ME_ops@example.com`; the same mailbox as `ALERT_TO` of `/etc/velexis/alert.env` and `OPS_ALERT_EMAIL` of `/etc/velexis/ota-backend.env` ([incident response plan](../../../ota/docs/pci/incident-response.md) §1). `SMTP_URL` and `MAIL_FROM` hold the real SMTP account. Restart the worker (it sends the e-mails) and the API: `sudo systemctl restart velexis-platform-worker velexis-platform-api`.
  - Owner: developer.
  - Check: the command below prints exactly one address, the operations mailbox. The first platform `ops.alert` reaches it: "Amadeus office pool low (live): 0 available", sent by the first daily `amadeus.pool_level` run (06:55 UTC) after the live Velexis Amadeus account exists and before its offices are added ([§5](#5-legal-contracts-and-amadeus)).

    ```bash
    sudo sh -c 'sed -n "s/^OPS_ALERT_EMAIL=//p" /etc/velexis/platform-backend.env /etc/velexis/ota-backend.env; sed -n "s/^ALERT_TO=//p" /etc/velexis/alert.env' | sort -u
    ```

  - Evidence: `platform/backend/src/supplier-connections/pool-level.scheduler.ts` (`POOL_LEVEL_MINIMUM`, the alert's title), the `ops.alert` template in `platform/backend/src/notifications/templates.ts`.
- [ ] **The first platform admin, through `admin:grant`.**
  - Do: sign up at `https://platform.example.com/sign-up` with your own work address (personal accounts only, PCI DSS 8), verify it, choose a password of at least 12 characters with at least one letter and one digit (the rule of every portal account since the lead's decision (15e) of 2026-11-11, FIX-W48-PLATFORM: the sign-up refuses a shorter one), enable MFA at `/account/security` and keep the recovery codes offline. Then, on the VM:

    ```bash
    sudo velexis-run platform node dist/cli.js admin:grant <your e-mail> --operator "<your name>"
    ```

    Exit `0` grants it; exit `1` says why (the account must be `active`, verified and have MFA).
  - Owner: developer.
  - Check: `https://admin.platform.example.com/sign-in` asks for the TOTP code and opens the dashboard; `/admins` lists exactly this account; `/audit` filtered on the action `admin.granted` shows one row, actor `system`, with the operator's name.
  - Evidence: `platform/backend/src/cli.ts` (`admin:grant`), `platform/backend/test/integration/admin/admin-cli.int.test.ts`. With a single admin, the way back from a lost authenticator is `admin:reset-mfa` on the VM ([`platform-operations.md` §6](platform-operations.md#6-lost-authenticator-of-an-owner-or-admin)).

## 4. Stripe, live mode (Velexis's account)

The platform uses Velexis's Stripe account for subscription billing, Connect Standard and the settlements' balance transactions. The OTA API uses the same account's keys for the payments of OTAs in `velexis` mode; those keys and its endpoints are the OTA checklist's items.

- [ ] **The platform's live secret key.**
  - Do: in the Stripe Dashboard (live mode), take the secret key (`sk_live_…`). A restricted key (`rk_live_…`) is accepted too, but only after each call the platform makes (Checkout Sessions, Customers, Subscriptions, Prices, Invoices, Customer Portal sessions, balance transactions, Connect OAuth token and deauthorisation) has worked with a test-mode restricted key of the same permissions. Put it into `STRIPE_SECRET_KEY` of `/etc/velexis/platform-backend.env` with `sudoedit`.
  - Owner: developer.
  - Check: `sudo grep -cE '^STRIPE_SECRET_KEY=(sk|rk)_live_' /etc/velexis/platform-backend.env` prints `1` (a count, never the key). After `sudo systemctl restart velexis-platform-worker velexis-platform-api` both units are `active` and `/health/ready` answers `200`: with `APP_ENV=production` the configuration refuses a test-mode key at start, and a missing key while a Stripe switch is on ([§7](#7-the-order-of-the-switches)), with `config.invalid` naming the variable, never its value.
  - Evidence: `platform/backend/src/config.ts` (`STRIPE_SWITCH_VARIABLES`, `stripeProblems`), `platform/backend/src/config.test.ts`.
- [ ] **The billing webhook endpoint.**
  - Do: in the Dashboard (live mode), add an endpoint for events on your account: URL `https://api.platform.example.com/webhooks/stripe/billing`, API version `2025-08-27.basil` (`STRIPE_API_VERSION` of `platform/backend/src/common/stripe/stripe.client.ts`), exactly these eight events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`. Its signing secret goes into `STRIPE_BILLING_WEBHOOK_SECRET`.
  - Owner: developer.
  - Check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://api.platform.example.com/webhooks/stripe/billing` prints `400`: the route is reachable through Caddy and refuses an unsigned body (`WEBHOOK_SIGNATURE_INVALID`; the API logs one `stripe.webhook_signature_invalid` security event for it, which is expected). `sudo grep -c '^STRIPE_BILLING_WEBHOOK_SECRET=whsec_' /etc/velexis/platform-backend.env` prints `1`. Once `FEATURE_STRIPE_BILLING` is on, the first real events show `200` in the endpoint's deliveries and `processed` on the admin's `/stripe-events`.
  - Evidence: `platform/backend/src/common/stripe/stripe-signature.guard.ts`, `platform/backend/src/common/stripe/stripe-inbox.service.ts` (an event of the other mode is refused, `livemode_mismatch`), `platform/backend/test/integration/billing/billing-webhook.int.test.ts`. Events that arrive while the switch is off are stored and marked `ignored` (PADR-0015 item 4); [§7](#7-the-order-of-the-switches) says when to reprocess them.
- [ ] **The Connect webhook endpoint.**
  - Do: add an endpoint for events on connected accounts: URL `https://api.platform.example.com/webhooks/stripe/connect-accounts`, the same API version, exactly two events: `account.updated` and `account.application.deauthorized`. Its signing secret goes into `STRIPE_CONNECT_WEBHOOK_SECRET`. The OTA API has its own two live endpoints for payment events (`https://api.ota.example.com/webhooks/stripe/velexis/live` and `https://api.ota.example.com/webhooks/stripe/connect/live`, the OTA checklist's items); the event lists never overlap ([architecture flow (d)](../../../docs/mvp/architecture.md#d-stripe-webhooks-platform-billing-vs-ota-payments)).
  - Owner: developer.
  - Check: the same `curl` against `/webhooks/stripe/connect-accounts` prints `400`; `sudo grep -c '^STRIPE_CONNECT_WEBHOOK_SECRET=whsec_' /etc/velexis/platform-backend.env` prints `1`; the Dashboard lists four live endpoints (these two and the OTA's two) whose event lists are disjoint. The first real `account.updated` (the first OTA that connects its own Stripe account) shows `200` and `processed` on `/stripe-events`.
  - Evidence: `platform/backend/src/payment-connections/connect-webhook.controller.ts`, `platform/backend/src/payment-connections/connect-account-events.handler.ts`, `platform/backend/test/integration/connections/connect-events.int.test.ts`.
- [ ] **Plans linked to live prices.**
  - Do: for each public plan, one Product and one recurring Price per interval in live mode, tax-exclusive, in the plan's currency; link them on `/plans/<code>` in the platform admin. A price no plan links must not be offered anywhere (Checkout or the Customer Portal): billing sync fails its events with `UNKNOWN_PRICE`. The free `early_access` plan of migration `0002` is public too, but has no price, no custom domains and no live mode: it stays the plan of the manual trials ([§6](#6-manual-trials-before-billing)), and once billing is on the portal shows it as a plan nobody can choose (`createTenant` answers `422 PLAN_NOT_AVAILABLE` for a plan without a Stripe price). The product owner decides whether it stays shown or loses "public" on `/plans/early_access`.
  - Owner: product owner (prices, `early_access`), with the developer (links).
  - Check: `/plans` shows every public plan but `early_access` with its product and prices; "Check prices" on each of them leaves no price warning; the decision about `early_access` is in the launch issue.
  - Evidence: `platform/backend/src/billing/price-check.ts`, `platform/backend/test/integration/billing/plans.int.test.ts`; [`subscription-billing.md`](../flows/subscription-billing.md) §A.
- [ ] **The Customer Portal configuration.**
  - Do: in the Dashboard's Customer Portal settings (live mode): updating the payment method on; invoice history on; cancellation at the end of the billing period only; plan switching on, between the linked prices of the public plans only; pausing off (Velexis does not offer it; billing sync treats `paused` like `past_due`); the terms and privacy links `https://platform.example.com/legal/terms` and `https://platform.example.com/legal/privacy`. Each portal session carries its own return URL, the OTA's billing page.
  - Owner: product owner (cancellation and plan-switch rules), with the developer.
  - Check: once `FEATURE_STRIPE_BILLING` is on, "Manage in Stripe" on `/otas/<tenantId>/billing` of an OTA with a Stripe subscription opens the portal with exactly these options and no pause; a plan switched there shows on the admin's `/subscriptions/<subscriptionId>` within a minute.
  - Evidence: `platform/backend/src/billing/checkout.service.ts` (the portal session), [`subscription-billing.md`](../flows/subscription-billing.md) §A item 3, §E and §F.
- [ ] **Failed payments and retries.**
  - Do: in the Dashboard's subscription and e-mail settings: Smart Retries on; Stripe's e-mails about failed payments and expiring cards on; after the last retry, cancel the subscription or mark it unpaid. Either one suspends the OTA (reason `billing`), so the retry window is how long an OTA shows the `past_due` banner before it is suspended.
  - Owner: product owner.
  - Check: the retry window (in days) and the final action are recorded in the launch issue.
  - Evidence: `platform/backend/src/billing/sync/status-rules.ts`, [`subscription-billing.md`](../flows/subscription-billing.md) §E.
- [ ] **The Connect platform settings.**
  - Do: Stripe approves Velexis as a Connect platform (an outside step: the platform profile and agreement). In the Dashboard's Connect settings (live mode): OAuth for Standard accounts on, with `https://platform.example.com/connect/stripe/callback` as the only redirect URI; the branding (name, icon, colour) that the OTA sees on Stripe's authorisation page. The live client id (`ca_…`) goes into `STRIPE_CONNECT_CLIENT_ID`.
  - Owner: product owner (approval, profile, branding), with the developer (OAuth settings, env file).
  - Check: `sudo grep -c '^STRIPE_CONNECT_CLIENT_ID=ca_' /etc/velexis/platform-backend.env` prints `1`. Once `FEATURE_OWN_STRIPE` is on: "Connect Stripe" on `/otas/<tenantId>/payments` of the developer's own OTA (owner, step-up) opens Stripe's authorisation page with Velexis's branding; "Deny" there brings the browser back to the payments page with `stripeConnect=denied`, and nothing changes.
  - Evidence: `platform/backend/src/payment-connections/stripe-connect.service.ts`, `platform/frontend/src/app/connect/stripe/callback/route.ts`, `platform/backend/test/integration/connections/stripe-connect.int.test.ts`.

## 5. Legal, contracts and Amadeus

- [ ] **Legal sign-off of Velexis-collected payments** ([PADR-0003](../adr/0003-settlement-of-velexis-collected-payments.md) follow-up, [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)).
  - Do: a written legal review of `velexis` mode (Velexis collects the travellers' payments on its own Stripe account and settles to the OTA monthly by bank transfer, without a reserve: PADR-0003 items 1, 11 and 12), and Stripe's written confirmation that its terms allow it, the Connect platform agreement included ([PADR-0011](../adr/0011-stripe-connect-standard-and-api-key-connections.md) follow-ups).
  - Owner: product owner, with legal counsel.
  - Check: both documents are dated and kept in the product owner's records (never in the repository); their dates are in [§8](#8-record). Until both exist, `FEATURE_SETTLEMENTS` stays `false`, and so no OTA can go live in `velexis` mode: go-live needs a verified payout account in that mode (`goLive`'s `payout_account` precondition), and payout accounts need the settlements switch (`setPayoutAccount` has `x-feature: settlements`).
  - Evidence: `platform/backend/src/provisioning/go-live.service.ts`, `platform/backend/test/integration/provisioning/go-live.int.test.ts`, `platform/backend/openapi/velexis-platform-api.openapi.yaml` (`setPayoutAccount`).
- [ ] **Terms of service and privacy notice.**
  - Do: the portal's `/legal/terms` and `/legal/privacy` still show placeholder text (PFE-004). Replace it with the approved text and change `termsVersion` in `platform/frontend/src/lib/terms.ts`, in a release (a code change through a task, never an edit on the VM).
  - Owner: product owner (the text, with legal counsel), with the developer (the release).
  - Check: `curl -s https://platform.example.com/legal/terms | grep -c 'Placeholder text'` and the same for `/legal/privacy` print `0`.
  - Evidence: `platform/frontend/src/lib/terms.ts`, `platform/frontend/src/lib/strings.ts` (`LEGAL_STRINGS.placeholder`).
- [ ] **The Amadeus live contract.**
  - Do: the Enterprise live contract, the certification, the IATA or ARC terms and the ticketing agreement are signed ([ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md)); the live client id and secret and the first live office ids are received.
  - Owner: product owner.
  - Check: the signing date is in [§8](#8-record).
  - Evidence: [ADR-0012](../../../docs/mvp/adr/0012-amadeus-account-model.md) (the Velexis account and its offices), [`amadeus-connection.md`](../flows/amadeus-connection.md) §A.
- [ ] **The live Velexis Amadeus account.**
  - Do: platform admin, `/amadeus/accounts`, create (step-up): environment `live`, base URL `https://travel.api.amadeus.com`, the live client id and secret. The `amadeus_account.verify` job requests a token with them.
  - Owner: developer.
  - Check: the account shows `active` with a recent `lastVerifiedAt` and no `lastError`. The next `amadeus.pool_level` run (06:55 UTC) e-mails "Amadeus office pool low (live): 0 available" to the operations mailbox, which is also the check of `OPS_ALERT_EMAIL` ([§3](#3-operations-mailbox-and-the-first-platform-admin)).
  - Evidence: `platform/backend/test/integration/supplier-connections/amadeus-accounts.int.test.ts`; [`amadeus-connection.md`](../flows/amadeus-connection.md) §A.
- [ ] **Live offices in the pool.**
  - Do: `/amadeus/offices`, add the live office ids in bulk (the notes name the contract), at least three and enough for the OTAs expected to go live in the first weeks. The booking queue of each shared office is the OTA checklist's item.
  - Owner: developer, with the product owner (who orders offices from Amadeus).
  - Check: the dashboard's office pool shows at least 3 `available` live offices, and the next `amadeus.pool_level` run sends no alert for `live`.
  - Evidence: `platform/backend/src/supplier-connections/pool-level.scheduler.ts`, `platform/backend/test/integration/supplier-connections/amadeus-offices.int.test.ts`.

## 6. Manual trials before billing

- [ ] **The production demo OTA, on `demo.ota.example.com`** (lead decision (19j) of 2026-11-12).
  - Why: Velexis's own OTA in production, which several checks watch: the external uptime monitor's "Demo storefront" (X-029, [deployment §13](../../../docs/mvp/deployment-single-vm.md#the-external-uptime-monitor)), the on-VM health check's daily payment page check (X-030, `HEALTHCHECK_STOREFRONT_HOST`, by default `demo.<STOREFRONT_BASE_DOMAIN>`), the scope of the ASV scan and the penetration test ([`ota/docs/pci/README.md`](../../../ota/docs/pci/README.md#9-before-live-the-penetration-test-and-the-asv-scan) §9), and the airline-card go-live's last checks ([`airline-card-go-live.md`](../../../ota/docs/runbooks/airline-card-go-live.md#3-turning-it-on) step 4). Until it exists Caddy gets no certificate for the host (the `ask` endpoint answers `404` for a host without an OTA), so the monitor and the payment page check alert.
  - Do: create the OTA "Velexis demo" with the key `demo` on the VM with the platform command `tenants:create-demo` (PBE-075, lead decision (20a) of 2026-11-13), run as the admin bootstrap is run ([§3](#3-operations-mailbox-and-the-first-platform-admin)). `demo` is a reserved key (`RESERVED_TENANT_KEYS` of `platform/backend/src/tenants/tenant-key.ts`), and stays so for everyone else: the portal's key check answers `reserved` and `createTenant` `409 TENANT_KEY_UNAVAILABLE`; this command is the only way to create it (`dev:seed`, which creates the local `demo` OTA, refuses `APP_ENV=production`). Its owner is your own account (the first platform admin's, active, verified and with MFA; the command refuses an unknown address or an account without MFA). Choose the OTA's country, currency and time zone with the product owner (values of the reference data; the owner can change them later in the portal's settings):

    ```bash
    sudo velexis-run platform node dist/cli.js tenants:create-demo <your e-mail> \
      --country <CC> --currency <CUR> --time-zone <Area/City> --operator "<your name>"
    ```

    It creates the OTA through `createTenant`'s own transaction, as the portal does (the tenant in the storefront environment `test`, the owner membership, the free `early_access` plan with its manual subscription, the verified sub-domain `demo.ota.example.com`, the setup job, which the worker then runs as for any OTA), whether `FEATURE_STRIPE_BILLING` is on or not, and then sets the manual subscription **Active** with the reason "Velexis demo OTA, not billed" through the service of `adminUpdateManualSubscription` ([§6](#6-manual-trials-before-billing) next item), so `billing.manual_trials` never e-mails its owner or suspends it, and it has no Stripe customer, invoice or settlement. The audit rows `tenant.created`, `tenant.reserved_key_used` and `subscription.manually_updated` have the actor `system`, `cli tenants:create-demo by <your name>`. Exit `0` prints the OTA's and the setup job's ids and the next step: within 24 hours, sign in to the portal and open `/otas/<tenantId>/setup` to reveal the initial test keys once. A second run changes nothing (exit `0`), or completes a run that stopped before its subscription step; exit `1` says why it refused (another owner's `demo`, a `demo` that is not active or provisioning, an unknown country, currency or time zone) and changes nothing; exit `2` is a usage error (any key but `demo` included).

    It belongs to Velexis, never to a customer: the product owner may be invited as an admin (with MFA) for its branding and texts. It stays in the `test` environment for good: searches and bookings use the shared Velexis **test** Amadeus account and its test offices, which every new OTA gets; payments use Stripe's test mode (the OTA API's test-mode keys), and the airline card stays off until the airline-card go-live tests it on this OTA's test storefront with a card of Amadeus's test environment ([`airline-card-go-live.md`](../../../ota/docs/runbooks/airline-card-go-live.md#3-turning-it-on) step 4; never in live). Nobody requests live access for it, submits own Amadeus or Stripe credentials, connects a Stripe account, saves a payout account or switches it live, so it never takes a live payment.
  - Owner: developer; the product owner approves its name, branding and texts.
  - Check: the platform admin's `/tenants/<tenantId>` of `demo` shows the status active, the storefront environment test, no "live since", the plan `early_access`, and a subscription of provider manual with the status active; `/audit` filtered on the action `tenant.reserved_key_used` shows one row, actor `system`, with your name. The OTA's `/otas/<tenantId>/amadeus` in the portal shows the Velexis test connection and no live request. On the VM `curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/internal/tls/ask?domain=demo.ota.example.com'` prints `200`; from outside the VM `curl -sS -o /dev/null -w '%{http_code}\n' https://demo.ota.example.com/` prints `200`, and the page shows the test banner. `sudo velexis-healthcheck --payment-pages`, then `sudo velexis-healthcheck --status`, shows `payment-inventory` and both `payment-page-*` checks `ok`; X-029's "Demo storefront" monitor is green.
  - Evidence: `platform/backend/src/tenants/demo-ota.command.ts` (`tenants:create-demo`), `platform/backend/test/integration/tenants/demo-ota.int.test.ts` (with `APP_ENV=production`: the OTA set up like a portal OTA, the active manual subscription, the audit rows, the refusals, and `demo` still refused by the portal and the API); `deploy/scripts/healthcheck.sh` (`HEALTHCHECK_STOREFRONT_HOST`) and [deployment §13](../../../docs/mvp/deployment-single-vm.md#13-monitoring-and-uptime) (the monitors and the health check's settings); `platform/backend/src/billing/sync/manual-trials.scheduler.ts` (an `active` manual subscription gets no trial e-mails and is never suspended), `platform/backend/test/integration/billing/billing-schedules.int.test.ts`; `platform/backend/src/tenants/tenant-key.ts` (the reserved keys and `VELEXIS_OWN_TENANT_KEYS`).
- [ ] **Review the manual trials.**
  - Why: every OTA created before billing has a manual trial (`early_access`, 90 days). From the moment `FEATURE_STRIPE_BILLING` is on, the daily `billing.manual_trials` run e-mails the owners 14 and 3 days before the trial's end, sets an ended trial `past_due` (with the `billing.trial_ended` e-mail when no notice was sent) and suspends the OTA 14 days later, unless a plan is chosen.
  - Do: list `/subscriptions` with provider `manual` and decide each with the product owner: keep the end, or move it or the OTA's plan (edit on `/subscriptions/<subscriptionId>`, with a reason). An OTA the product owner bills outside Stripe gets its manual subscription set **Active** there (`adminUpdateManualSubscription` with `status: active`, since the lead's decision (15g) of 2026-11-11, FIX-W48-PLATFORM): it then gets no trial e-mails, is never suspended for its trial, and go-live accepts it.
  - Owner: product owner (the decisions), with the developer (the edits).
  - Check: every manual `trialing` subscription ends at least 14 days after the day billing is switched on, or its exception is written in the launch issue; every manual `active` one is the demo OTA (the item above) or an OTA the product owner bills outside Stripe, named in the launch issue.
  - Evidence: `platform/backend/src/billing/sync/manual-trials.scheduler.ts`, `platform/backend/test/integration/billing/billing-schedules.int.test.ts`; [`subscription-billing.md`](../flows/subscription-billing.md) §G.

## 7. The order of the switches

Each switch goes on alone, only once its prerequisites above are checked, and is verified before the next one; a switch stays off in production until its outside step is done ([`roadmap.md`](../../../docs/mvp/plans/roadmap.md) M5, "Production rule"). The order follows what each one needs: custom domains need no outside step; billing needs Stripe; own Amadeus credentials need nothing more; own Stripe needs Stripe's Connect approval; settlements need the legal sign-off; the live switch comes last, because go-live needs the live Amadeus account, live payments and, in `velexis` mode, a verified payout account.

The same procedure for each switch:

```bash
sudoedit /etc/velexis/platform-backend.env                  # FEATURE_<NAME>=true, and the variables it needs
sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only envfiles
sudo systemctl restart velexis-platform-worker velexis-platform-api
systemctl is-active velexis-platform-worker velexis-platform-api
curl -fsS http://127.0.0.1:3100/health/ready; echo
curl -fsS http://127.0.0.1:3101/health/ready | jq -c '{status, checks}'
sudo grep -H '^FEATURE_' /etc/velexis/platform-backend.env
```

A unit that does not come back: `sudo journalctl -u velexis-platform-api -n 20 -o cat` shows `config.invalid` with the name of the missing variable (never a value); set it, or set the switch back to `false`, and restart. Turning a switch off again later is the same procedure with `false`: its endpoints answer `403 FEATURE_DISABLED`, its schedules stop, and Stripe keeps delivering its events, which are stored and marked `ignored` (PADR-0015 item 4). After each switch, the platform admin and the portal show its pages (both read the switches from the API: `adminGetMe.features`, `getMe.features`). PBE-064 removes the switches one release after all six have been on (after the launch).

- [ ] **1. `FEATURE_CUSTOM_DOMAINS`.**
  - Needs: `STOREFRONT_IPV4` (and `STOREFRONT_IPV6` when the VM has an IPv6 address), `DNS_RESOLVERS`.
  - Owner: developer.
  - Check: on `/otas/<tenantId>/domains` of the developer's own OTA, on a plan with custom domains (`early_access` has none, and billing is still off: an admin moves the OTA's manual trial to such a plan on `/subscriptions/<subscriptionId>`, with a reason), add a domain you control (`<custom-domain>`), create its `_velexis` TXT record and the CNAME to `<key>.ota.example.com`, "Check now": the domain is `verified`, then its TLS `issued` within minutes; `curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3100/internal/tls/ask?domain=<custom-domain>'` prints `200` and `https://<custom-domain>/` shows the storefront with a valid certificate. Remove the domain afterwards: `ask` answers `404`.
  - Evidence: `platform/backend/test/integration/domains/custom-domains.int.test.ts`, `domain-verification.int.test.ts`, `tls-ask.int.test.ts`; [`custom-domains.md`](../flows/custom-domains.md).
- [ ] **2. `FEATURE_STRIPE_BILLING`.**
  - Needs: [§4](#4-stripe-live-mode-velexiss-account) (the key, the billing endpoint, the linked plans, the Customer Portal, the retries) and [§6](#6-manual-trials-before-billing).
  - Owner: developer.
  - Check: from your own account, create a throwaway OTA on a public plan with a trial and complete Checkout with a Velexis card (nothing is charged during the trial). Within a minute `/stripe-events` lists `checkout.session.completed` and `customer.subscription.created` as `processed`, the OTA provisions and its billing page shows the trial; "Manage in Stripe" opens the Customer Portal as [§4](#4-stripe-live-mode-velexiss-account) describes; cancel the subscription there. Then review `/stripe-events` with status `ignored` and reprocess any event that arrived while the switch was off and still matters.
  - Evidence: `platform/backend/test/integration/billing/checkout.int.test.ts`, `billing-events.int.test.ts`; `tools/e2e/specs/portal-checkout.e2e.ts` (test mode, in the nightly `portal-stripe` project).
- [ ] **3. `FEATURE_OWN_AMADEUS`.**
  - Needs: nothing more. Own test credentials need no live switch; `AMADEUS_BASE_URL_TEST` and `AMADEUS_BASE_URL_LIVE` stay empty in production (the official hosts; production accepts nothing else).
  - Owner: developer.
  - Check: `/otas/<tenantId>/amadeus` of your own OTA shows the own-credentials form of the `test` environment; a submission with a wrong secret is refused by the verification within minutes (the submitter gets the `connection.credentials_failed` e-mail), and the Velexis test connection keeps working.
  - Evidence: `platform/backend/test/integration/supplier-connections/own-credentials.int.test.ts`, `platform/backend/test/integration/connections/credential-submissions.int.test.ts`; [`amadeus-connection.md`](../flows/amadeus-connection.md) §D.
- [ ] **4. `FEATURE_OWN_STRIPE`.**
  - Needs: the Connect platform settings and the Connect endpoint of [§4](#4-stripe-live-mode-velexiss-account) (`STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`); the OTA API's Connect endpoint (OTA checklist).
  - Owner: developer.
  - Check: the "Deny" round trip of the Connect settings item ends with `stripeConnect=denied` and nothing changed. The own-keys form of the `test` environment takes a submission (step-up) of made-up test keys: its answer shows the webhook URL `https://api.ota.example.com/webhooks/stripe/c/<ppc_id>` with the seven events, then the verification refuses the keys (the submitter gets the `connection.credentials_failed` e-mail) and the connection stays as it was.
  - Evidence: `platform/backend/test/integration/connections/stripe-connect.int.test.ts`, `stripe-api-keys.int.test.ts`.
- [ ] **5. `FEATURE_SETTLEMENTS`.**
  - Needs: the legal sign-off and Stripe's confirmation ([§5](#5-legal-contracts-and-amadeus)); `STRIPE_SECRET_KEY`.
  - Owner: developer, after the product owner's go.
  - Check: on your own OTA, the owner saves a payout account at `/otas/<tenantId>/payments/payout-account` (step-up): the operations mailbox gets the payout-review `ops.alert`, and the admin verifies the account on `/tenants/<tenantId>`. On the 3rd of the next month (05:00 UTC) `settlements.monthly` builds the drafts on `/settlements`, whose totals must reconcile with Stripe's balance transactions before any is approved.
  - Evidence: `platform/backend/test/integration/settlements/payout-accounts.int.test.ts`, `settlement-generation.int.test.ts`, `settlement-review.int.test.ts`; `tools/e2e/specs/portal-payments.e2e.ts`, `tools/e2e/specs/admin-settlements.e2e.ts`; PADR-0003.
- [ ] **6. `FEATURE_LIVE_SWITCH`, last.**
  - Needs: the live Velexis Amadeus account `active` with live offices ([§5](#5-legal-contracts-and-amadeus)); live payments of the OTA API (OTA checklist); for `velexis` mode the settlements switch and a verified payout account. The first OTA itself needs a plan with live mode and a Stripe subscription that is `trialing` or `active`, or a manual subscription a platform admin set `active` (goLive's `plan_live_mode` and `subscription` preconditions): `early_access` has no live mode, so the OTA goes through Checkout, or, billed outside Stripe, an admin moves its manual subscription to a plan with live mode and sets it `active` ([§6](#6-manual-trials-before-billing); FIX-W48-PLATFORM, lead decision (15g) of 2026-11-11).
  - Owner: developer; the product owner chooses the first OTA to go live.
  - Check: the first OTA to go live (Velexis's own pilot OTA or the first customer's) requests live access on `/otas/<tenantId>/amadeus`: the operations mailbox gets the live-office-request `ops.alert`, the admin dashboard lists the request, "Assign office" serves it and the owner is e-mailed. `/otas/<tenantId>/go-live` then shows every precondition met, the switch succeeds, and `https://<key>.ota.example.com/` no longer shows the test banner.
  - Evidence: `platform/backend/test/integration/supplier-connections/live-office.int.test.ts`, `platform/backend/test/integration/provisioning/go-live.int.test.ts`; `tools/e2e/specs/admin-live-office.e2e.ts`, `tools/e2e/specs/portal-go-live.e2e.ts`.

## 8. Record

One row per walk-through, with the dates of the outside steps (legal review, Stripe's confirmation, Connect approval, Amadeus contract). Never a secret.

| Date | Release (sha) | Who | Items done | Open items, each with its owner | Outside steps (dates) | Where the ticked list is |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |
