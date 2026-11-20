---
id: usage
title: Portal — usage guide
summary: How to run the portal and walk every screen - sign-up to go-live, team, keys, domains, Amadeus, Stripe, billing and Open console - with what should happen and what to check in PostgreSQL, Redis and Mailpit.
---

## What it is

The [[portal]] (`repo:platform/frontend`, package `@velexis/platform-frontend`) is the website of Velexis for its
customers: people who run an online travel agency. On it a visitor creates an [[account]] and an OTA (a [[tenant]]),
pays for its [[plan]] (a [[subscription]]), waits for its set-up, gets [[api-key]]s, adds [[custom-domain]]s, connects
Amadeus ([[supplier-connection]]) and Stripe ([[payment-connection]]), invites a team ([[invitation]],
[[membership]]), switches to live ([[go-live]]) and opens the OTA's back office (the [[app:ota-admin]]) with one click.

It is a Next.js 15 App Router app and a [[bff]] of the [[app:platform-api]]: the browser talks only to the portal,
the portal server calls the platform API with the person's token, and the tokens live in httpOnly [[host-cookie]]s
that browser JavaScript can never read. The portal stores no data of its own: every row you see is a row of the
`platform` schema that the API wrote.

```diagram
neighbours
```

| Who | Uses it for |
|---|---|
| Visitor | Pricing, sign-up, sign-in, password reset |
| OTA owner | Everything of their OTA, including billing, the payout account and going live |
| OTA admin, agent, finance member, viewer | What their [[tenant-role]] allows (see [Roles and permissions](#roles-and-permissions)) |
| Invited person | The invitation page, then the OTA |

## Before you start

The portal needs the platform API (and its worker) behind it; creating an OTA also needs the OTA worker and the
Amadeus stub. Everything runs natively (no Docker), as in `repo:docs/mvp/local-development.md`.

```diagram
flow-local-setup
```

```try
command: mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 &
command: pnpm stub:amadeus &
command: pnpm dev
url: http://localhost:3000/
expect: The landing page; http://localhost:3000/health/ready answers {"status":"ok","checks":{"platformApi":"ok"}}
```

| What | Value (development only) |
|---|---|
| Portal | http://localhost:3000 (binds 127.0.0.1:3000) |
| Platform API it calls | `PLATFORM_API_URL=http://127.0.0.1:3100` |
| OTA admin of "Open console" | `PUBLIC_OTA_ADMIN_URL=http://localhost:3002` |
| E-mails (verification, reset, invitations, welcome) | Mailpit http://localhost:8025 |
| Seeded portal accounts | **None**: sign up yourself. `dev:seed` creates only the platform admin `admin@example.com` (for the [[app:platform-admin]]) |
| Database (read-only checks) | `psql postgres://velexis_platform_app:dev_platform@127.0.0.1:5432/velexis` |
| Redis | `redis-cli -a dev_redis` |
| Storefront links | point at `https://<key>.ota.example.com/`, which does not resolve locally; the local storefront is http://localhost:5173 |

```warning
Browse **http://localhost:3000**, the origin of `PUBLIC_PORTAL_URL` in the root `.env.example`, even though the dev
server binds `127.0.0.1:3000`. On `http://127.0.0.1:3000` the cookies belong to another host than the middleware's
redirects (`localhost`), and **Sign out** and **Open console** answer `403` because their `Origin` check compares with
`PUBLIC_PORTAL_URL` (development only; the same trap exists in the [[app:platform-admin]]).
```

```note
Many portal sections appear only while a milestone [[feature-switch]] of the platform API is on. In
`.env.local` (root or `platform/backend/.env.local`) they are all `false` by default: `FEATURE_STRIPE_BILLING`
(paid plans, Checkout, invoices), `FEATURE_OWN_STRIPE` (Stripe Connect and own keys), `FEATURE_SETTLEMENTS` (payout
account, settlements), `FEATURE_OWN_AMADEUS` (own Amadeus credentials), `FEATURE_CUSTOM_DOMAINS` and
`FEATURE_LIVE_SWITCH` (go-live, live access, live keys). The portal reads them from `getMe.features`; restart the
platform API and worker after a change. Stripe switches also need `STRIPE_*` test values and `stripe listen`.
```

```tip
To test roles, use several browsers or private windows: one per person. Each sign-up from one IP counts towards the
API's per-IP limit (5 sign-ups an hour).
```

## Tour

### Public pages

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/` | Landing: "Your own online travel agency, ready to sell flights.", three steps, what every OTA gets | Click **Get started**, **See pricing** (and the header's **Pricing**, **Sign in**) | One `h1`; links to `/sign-up` and `/pricing`; no API call |
| `/pricing` | Public plans of `listPlans` in `sort_order`: monthly/annual price, trial days, limits | Stop the platform API and reload | Plans with **Start** → `/sign-up?plan=<code>` (sign-up ignores `plan`: the plan is chosen again in the wizard); with the API down the portal's message and a sign-up link, never the API's text |
| `/legal/terms`, `/legal/privacy` | Placeholder texts under "Version `termsVersion`" | Compare the version with `accounts.terms_version` after a sign-up | Same version string (`repo:platform/frontend/src/lib/terms.ts`) |

### Sign-in pages (`(auth)`)

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/sign-up` | "Create your Velexis account": full name, e-mail, password, terms | 11-character password; untick terms; an existing address | Errors at the fields and a focused summary; existing address answers exactly like a new one |
| `/sign-up/check-email` | "Check your e-mail", ask for a new link | Ask 4 times in an hour | Same confirmation for any address; the 4th says 3 links per hour |
| `/verify-email?token=…` | Route handler, no page | Open the link twice | 1st: `/sign-in?verified=1` (signed in: `/dashboard`); 2nd: `/verify-pending?error=token` ("This verification link has expired or was already used…"), or straight on to `/dashboard` when this browser is signed in and verified |
| `/verify-pending` | "Verify your e-mail address": the only page of an unverified account | Sign in before verifying, then open `/dashboard` | Always back here; **Send a new link**; after verifying in another tab "Your e-mail address is verified" with **Continue to your dashboard** |
| `/sign-in` | "Sign in to Velexis" | `?next=https://evil.example/x`, wrong password ×5 | Unsafe `next` ignored ([[safe-next-path]]); lock-out message with the wait |
| `/sign-in/mfa` | "Two-factor authentication": code or recovery code | Wrong code; wait 5 min | Error at the field; expired challenge → `/sign-in?mfa=expired` |
| `/forgot-password` | "Reset your password" | Unknown address | Same confirmation as for a real one |
| `/reset-password` | "Choose a new password" (needs the reset cookie) | Open `/reset-password` directly | "Open the link from your e-mail" with a link to ask again |
| `/invitations/accept` | "Your invitation": OTA, inviter, role, address, expiry | Open with another account signed in | "This invitation is for another address" and a sign-out button, no Accept |
| `/mfa-enrolment` | "Set up two-factor authentication" (the [[mfa-enrolment-gate]]) | Admin of a live OTA without MFA | Only this page until MFA is on, then **Continue** to `next` |

### Your account (`(app)`, any verified account)

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/dashboard` | "My OTAs": each OTA with status, Test mode, key, plan name, your role, storefront link, **Open console**; **Create an OTA** | No OTA yet; a provisioning OTA | "You have no OTA yet"; a provisioning or failed OTA links to its set-up page; the storefront link is always `https://<key>.<STOREFRONT_BASE_DOMAIN>/` (see the bug-hunt below) |
| `/otas/new` | "Create an OTA" wizard: OTA details → Plan → Review | Taken key, reserved key `admin`, 4th OTA | Live key check; limit message on the review (`MAX_TENANTS_PER_ACCOUNT=3` locally) |
| `/console?tenant=<id>` | "Open the OTA admin": your OTAs with **Open console** | A tenant you are not in | Note, nothing selected; a single OTA is selected by default |
| `/account` | "Your profile": name, language, time zone; e-mail read-only | Save in two tabs | Second tab: "Reload the page" (`If-Match` refused) |
| `/account/security` | "Security": password, two-factor, "Where you are signed in" (portal and platform admin sessions), **Sign out everywhere** | Set up MFA, revoke a session | QR code + key; ten recovery codes once; "This browser" cannot be revoked |

### An OTA's pages (`/otas/<tenantId>/…`)

Every page sits under the OTA layout, which shows the [[tenant-banner]] ([[suspension]], payment failed or trial
ending from the [[billing-notice]], and test mode while the [[storefront-environment]] is `test`). A page your role may not open shows the [[not-allowed-page]]; an OTA you are not a member of (or a malformed id) shows
Next.js's default, unstyled "404 This page could not be found." without the portal's shell (the app has no
`not-found.tsx`).

| Route | Roles | What it shows | Try | Should happen |
|---|---|---|---|---|
| (overview) | all | Name, status, storefront, key, role, currency, [[onboarding-checklist]] "Get your OTA ready", **Open console**, **Edit the OTA profile** (owner, admin) | Finish items one by one | Items turn "Done" on the next load; nothing is stored about the list |
| `/setup` | all (retry, reveal, payment: owner) | The [[setup-page]]: steps with progress, ready, failed, payment needed | Watch a new OTA; stop the OTA worker | "Your OTA is ready" within a minute; with the worker down it keeps polling |
| `/settings` | owner, admin | "OTA settings": name, legal name, support e-mail, country, time zone; key and currency read-only | Suspended OTA; stale tab | Fields disabled with the reason; "Reload the page" |
| `/api-keys` | owner, admin | "API keys": Test keys tab (Live keys once live), create, edit, roll, revoke | Create, reload | Key shown once ([[show-once-secret]]), then only `prefix…last4` |
| `/domains` | all (changes: owner, admin) | "Velexis address" and "Custom domains" with DNS records | Add `travel.acme.example` | Pending view with TXT and CNAME/A records and **Check now** |
| `/amadeus` | owner, admin, finance (read) | Connection cards, settings, live access, own credentials | Change monitored queues | "saved"; finance sees the values as text |
| `/payments` | owner, admin, finance (read) | Stripe cards, card statement suffix, Stripe Connect, own keys | Suffix `ACME*TRAVEL` | Refused in the browser, never sent |
| `/payments/payout-account` | owner (edit), finance (read) | Masked bank account and review status | Save a test IBAN | Step-up, then "•••• 7947", "Pending review" |
| `/payments/settlements` and `/<stl_…>` | owner, finance | Monthly statements, totals, CSV | Download the CSV | `velexis-statement-<yyyy-mm>-<CUR>.csv` |
| `/team` | all (changes: owner, admin) | "Members" (with **Leave this OTA** on your own row), "Pending invitations" and "Invite someone" (owners, admins) | Invite, change role, remove | See [Team](#team-and-invitations). Only owners and admins have **Team** in the navigation; the other roles reach the page by URL or the checklist's "Invite your team" |
| `/billing` | owner, finance (read) | Plan, status, choose a plan, **Manage in Stripe**, invoices | Manual trial before M5 | "Free trial, no payment details needed", "Paid plans arrive soon" |
| `/go-live` | owner | "What going live needs" (six items) and **Go live** | Try with nothing done | Confirm "Switch your storefront to live?", step-up, then "Your OTA cannot go live yet" naming exactly what is missing |

### Route handlers you can call

| Route | Method | Try | Should happen |
|---|---|---|---|
| `/sign-out` | POST | `curl -i -X POST http://localhost:3000/sign-out -H 'Origin: http://evil.example'` | `403`, nothing changes; from the page's form: `303 /sign-in?signedOut=1` |
| `/otas/<id>/console/launch` | POST | Same with a foreign Origin; `GET` | `403`; `GET` → `303 /console?tenant=<id>` |
| `/connect/stripe/callback` | GET | Open it without `state`, signed in | No API call; `303 /dashboard` (no Connect cookie) or the payments page with `?stripeConnect=state_invalid`; signed out → sign-in; `HEAD` → `405` |
| `/otas/<id>/payments/settlements/<stl_…>/lines.csv` | GET | A draft's id | `404` plain text; `HEAD` → `405` |
| `/health/live`, `/health/ready` | GET | Stop the platform API | `ready` → `503 {"status":"unavailable","checks":{"platformApi":"down"}}` |

## How to …

### Sign up and verify

```diagram
flow-sign-up
```

### Sign in, two-factor and password reset

```diagram
flow-sign-in-mfa
```

```diagram
flow-reset-password
```

### Create an OTA

1. **Create an OTA** on `/dashboard` (only for a verified account).
2. Fill *OTA details*. The key follows the name until you type your own; the field checks it as you type (the
   [[tenant-key]] must match `^[a-z][a-z0-9]{2,29}$` and not be reserved: `platform`, `admin`, `api`, `www`, `app`,
   `console`, `test`, `demo`, …).
3. *Plan*: before M5 only early access. With `FEATURE_STRIPE_BILLING` on, choose a plan and interval.
4. *Review* → **Create OTA**. The wizard sends one [[idempotency-key]] for every submit, so a double click makes one
   OTA.
5. The [[setup-page]] follows the [[provisioning-job]] and offers the one-time [[initial-keys-reveal]].

```diagram
flow-create-ota
```

```diagram
key-check-states
```

### Manage API keys

```diagram
flow-api-keys
```

Keys are `pk_test_…`/`sk_test_…` (live: `pk_live_…`/`sk_live_…`) with 40 base62 characters; the portal shows only
`prefix…last4`. A secret key's [[key-scope]] is `storefront`, `console`, or `console:automation` with permissions.
Creating a **live** secret key asks for a [[step-up]].

### Team and invitations

```diagram
flow-team
```

```diagram
flow-accept-invitation
```

### Open the console

"Open console" is a small form, never a link, so prefetching cannot mint a [[portal-token]]. See [[sso]].

```diagram
flow-open-console
```

### Custom domains

```diagram
flow-custom-domain
```

### Amadeus connection

```diagram
flow-amadeus
```

### Payments, payout account and settlements

```diagram
flow-payments
```

```diagram
flow-payout-settlements
```

### Billing

```diagram
flow-billing
```

### Go live

```diagram
flow-go-live
```

### Profile and security

```diagram
flow-account-security
```

### The MFA enrolment gate

```diagram
flow-mfa-enrolment
```

## Roles and permissions

The portal hides what a role may not do (`repo:platform/frontend/src/lib/roles.ts`); the API refuses it again with
`403`. A page your role may not open shows "You cannot open this page" with your role and who can change it (the
[[not-allowed-page]]); its navigation entry is missing.

| Action | Owner | Admin | Agent | Finance | Viewer |
|---|---|---|---|---|---|
| Overview, domains (read), Open console | yes | yes | yes | yes | yes |
| Edit OTA profile, API keys, add/verify/remove domains | yes | yes | – | – | – |
| See Amadeus and payment connections | yes | yes | – | yes | – |
| Change connections, own credentials, Stripe Connect | yes | yes | – | – | – |
| Invite and manage agents, finance, viewers | yes | yes | – | – | – |
| Grant or remove owner and admin | yes | – | – | – | – |
| See subscription, plan, invoices | yes | – | – | yes | – |
| Choose a plan, Manage in Stripe | yes | – | – | – | – |
| See payout account and settlements | yes | – | – | yes | – |
| Set the payout account, Use Velexis payments, go live, retry set-up, reveal test keys | yes | – | – | – | – |

Extra rules: [[mfa]] is mandatory for an owner or admin of a live OTA ([[mandatory-mfa]]); granting `owner`,
creating live secret keys, own credentials, Stripe Connect, the payout account, Use Velexis payments and go-live need
a [[step-up]] within 15 minutes; the last owner can neither leave nor be demoted (`LAST_OWNER`).

```bug-hunt
Walk every OTA page as each role (portal-roles.e2e.ts does it automatically). Look for: a navigation entry that leads
to the not-allowed page, a button the API then refuses with 403, finance seeing a form (it should see text and a note),
an admin seeing "owner" or "admin" in the role selector, and agents/viewers calling listInvitations (they must not).
```

## Bug-hunting checklist

```bug-hunt
**Sign-up and verification**
- Password rule: 12 to 256 code points with a letter and a digit; an emoji counts as one. 11 characters must be refused
  without an API call; the name and address stay, the password never does.
- Full name max 200 UTF-16 units (100 emoji fit, 101 do not). Trimmed address ≤ 254.
- An existing address: same page, one e-mail "You already have a Velexis account", no new `accounts` row:
  `select id, status, created_at from platform.accounts where lower(email)=lower('<address>');`
- Link once only; a second click → `/verify-pending?error=token`. The URL after the redirect carries no token.
- `select template, status, secrets_purged_at from platform.email_outbox order by created_at desc limit 5;` — sent rows
  must have `secret_payload_ciphertext` null.
```

```bug-hunt
**Sessions and cookies**
- DevTools → Application → Cookies: `__Host-vxp_at` (≤15 min) and `__Host-vxp_rt` are HttpOnly, Secure, `Lax`;
  `__Host-vxp_mfa`, `__Host-vxp_reset`, `__Host-vxp_invite` are `Strict`. `document.cookie` in the console shows none.
- Leave a tab 20 minutes, then click: the page must load without a sign-in (the middleware's
  [[single-flight-refresh]]). Open 5 tabs at once after expiry: no "session ended" (no refresh-token reuse).
- `select family_id, audience, revoked_at, revoke_reason from platform.account_sessions where account_id='<acc_…>' order by created_at desc;`
- Sign out everywhere in browser A: browser B's next click goes to sign-in within 15 minutes; its OTA admin session
  ends ([[staff-deny-cut-off]]: `redis-cli -a dev_redis get staffdeny:acct:<acc_…>` holds a time).
- Turning two-factor on or off, or replacing the recovery codes, sends "The two-factor authentication of your Velexis
  account changed" (`auth.mfa_changed` in `platform.email_outbox`).
```

```bug-hunt
**Create OTA and set-up**
- Double-click **Create OTA** (or throttle the network): one row only —
  `select key, status, plan_code, storefront_environment from platform.tenants order by created_at desc limit 3;`
- Keys `ab` (too short), `1abc`, `acme-travel`, `admin` are refused at the field (`Acme` is lower-cased as you type, so it
  becomes `acme`); a key taken in another browser between check and submit → back to step 1.
- With 3 OTAs that are not `failed`, **Create an OTA** is still offered; the limit shows only on the review after all
  three steps ("You already own 3 OTAs, the most one account can have…").
- `/pricing` → **Start** opens `/sign-up?plan=<code>`, but neither sign-up nor the wizard reads `plan`.
- After set-up: `select status, step, attempt, jsonb_array_length(steps) from platform.provisioning_jobs where tenant_id='<ten_…>';`
  should be `succeeded`; `supplier_connections` and `payment_provider_connections` have a `test` row; `api_keys` two rows.
- Reveal the keys; reload: no reveal button. `select revealed_at, reveal_ciphertext is null from platform.provisioning_jobs where tenant_id='<ten_…>';`
- Kill the OTA worker during set-up: the page keeps polling; after restart it finishes. A failed set-up shows the step,
  attempts and job id, never the error text.
- Welcome e-mail "<OTA> is ready on Velexis" to every owner, once.
```

```bug-hunt
**API keys**
- The full key appears once; it must not be in the URL, `localStorage`, the page source after reload, or the logs.
- Origins: `https://Acme.example` (upper case), `https://acme.example/` (slash), `https://*.acme.example`,
  `http://acme.example` (http on a non-localhost) must all be refused at their row; **Add an origin** is disabled at 20.
- Roll with "now": the old key's `expires_at` is in the past and the table says it stopped working.
- Plan limit: `select limits->'apiKeys' from platform.plans where code='early_access';` then create one more →
  "PLAN_LIMIT_REACHED" with limit and used numbers.
- `last_used_at` updates at most every 5 minutes after you use a key against the OTA API.
```

```bug-hunt
**Team and invitations**
- Admin's role selector offers only agent, finance, viewer. Granting owner asks for a step-up.
- Every team change publishes a `vx:invalidate` membership message; the OTA admin follows within seconds.
- Seat count includes pending invitations: `select status, count(*) from platform.tenant_invitations where tenant_id='<ten_…>' group by 1;`
- The invitation link opened after 15 minutes in the same browser (cookie expired) or in another browser: the page must
  explain, not crash. A revoked or resent (old) link → "cannot be used".
- After a new account verifies its e-mail it lands on `/sign-in?verified=1` with no way back to the invitation (sign-up
  and `/verify-email` drop `next`): the invitation page's hint "…verify it, then sign in and open the invitation link
  again" is the only guidance.
- Removed member: `tenant_memberships.status = 'removed'`; their OTA pages show "This page could not be found." and the
  OTA admin ends their session within 60 s.
```

```bug-hunt
**Open console**
- Suspended OTA (suspend it in the platform admin): the overview explains the reason; billing suspensions show the
  billing link only to owners and finance.
- Live OTA, member without MFA: `/account/security?console=mfa_required&tenant=<id>` with "Open the console again".
- `redis-cli -a dev_redis --scan --pattern 'ptk:*'` right after a launch: one key with TTL ≤ 60; gone after the OTA
  admin redeemed it.
```

```bug-hunt
**Domains, Amadeus, payments**
- The dashboard card links `https://<key>.<STOREFRONT_BASE_DOMAIN>/` even when a verified custom domain is primary or the
  OTA is still provisioning, failed or suspended; the OTA overview links `https://<primaryHost>/` and says "The
  storefront opens when the set-up is done" while provisioning or failed.
- Custom domain inputs: `https://travel.acme.example`, `travel.acme.example/path`, a 254-character host, a host under
  `ota.example.com`, `github.io` sub-domains → refused (some by the portal, the rest by the API at the field).
- **Check now** twice within a minute → "try again in …" from `Retry-After`.
- Amadeus settings: queue number 100, category 255, the same queue twice (`08` and `8`) → each refused at its row
  without a call; the add buttons stop at 20 monitored queues and 31 automated processes.
- Statement suffix: 1 character, 23 characters, `ÄCME`, `ACME & CO`, `1234` (no letter) → refused; preview cuts at 22.
- Own credentials secret: after a refusal it stays typed; after 202 it is emptied; it never appears in the network
  answer of the action (DevTools → Network → the POST's response).
- Each [[credential-submission]]: `select kind, environment, status, error_code from platform.credential_submissions where tenant_id='<ten_…>' order by created_at desc;`
```

```bug-hunt
**Billing, payout, settlements (money and time zones)**
- Amounts are decimal strings formatted with `Intl`: JPY shows no decimals (`¥5,000`), EUR two (`€49.00`); no float
  rounding (try a large amount in a fixture).
- A [[manual-subscription]] (trial) shows no Checkout before M5; one an admin set `active` reads "Billed by Velexis
  directly, outside Stripe" and offers no plan choice.
- Dates: trial end and invoice periods in the OTA's time zone; settlement months and transfer dates in **UTC**. Set the
  OTA's time zone to `Pacific/Auckland` and check an end-of-month invoice period.
- `?checkout=success` must not claim success before the webhook: stop `stripe listen` and watch "Confirming your
  payment" keep polling.
- [[payout-account]]: IBAN with spaces and lower case is accepted and normalised; wrong checksum refused; the stored row
  has only `last4` in clear: `select last4, status, review_note from platform.tenant_payout_accounts;`
- The [[settlement]] list never shows `draft` or `void` statements; their ids answer 404.
```

```bug-hunt
**Go-live and the MFA gate**
- Each missing precondition named in `details.missing` shows "Missing"; an unknown value adds "Something else Velexis
  needs is missing". After success: `select storefront_environment, live_enabled_at from platform.tenants where id='<ten_…>';`
- After go-live, sign in as an admin of that OTA without MFA: only `/mfa-enrolment`; every typed URL returns there.
- Turn off two-factor as an owner of a live OTA: the button must be hidden (or the `mfa_mandatory` message shown).
```

```bug-hunt
**Errors, headers and accessibility**
- Stop the platform API while on any page: the portal's own message per code, never a stack trace or the API's text.
- Response headers: `Content-Security-Policy` with a fresh nonce per request, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on `/verify-email` and token pages,
  `strict-origin` on the console hand-off), `Permissions-Policy`, no `X-Powered-By`. Behind Caddy (production) the
  shared `security_headers` snippet replaces every `Referrer-Policy` header with `strict-origin-when-cross-origin`; the
  token and hand-off pages keep their policy through `<meta name="referrer">`.
- An unknown OTA id or a removed member's OTA shows Next.js's default "404 This page could not be found." page (no
  shell, no way back); an unexpected server error shows Next.js's default error page (no `error.tsx` exists).
- Keyboard only: the skip link, every error summary takes the focus, dialogs trap focus and Escape cancels.
- Narrow window (360 px): the shell, tables and dialogs must not scroll sideways.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every page says the service is unavailable | Platform API not running or `PLATFORM_API_URL` wrong | Start it; `curl http://127.0.0.1:3100/health/live` |
| First request fails with a configuration error | Missing or invalid env (`ConfigError` names the variable) | Copy `.env.example` to `.env.local`; `PLATFORM_BFF_KEY` must equal the API's |
| API answers `400 VALIDATION_FAILED` on every call | Malformed `X-Forwarded-For` reached the portal (a proxy in front) | Remove the proxy or fix the header; locally no header means `127.0.0.1` |
| Sign-up says too many attempts | 5 sign-ups per IP and hour | Wait, or use another end-user IP (e2e uses `uniqueTestIp`) |
| No e-mail arrives | Mailpit or the platform worker not running | Start both; check `platform.email_outbox.status`/`last_error` |
| Set-up stays at "dispatch" | OTA worker not running, or (M5) Checkout not paid | Start `@velexis/ota-backend` dev; check `provisioning_jobs.status` |
| Amadeus card says "pending_verification", no office | Office pool empty or the stub was down at `dev:seed` | Start `pnpm stub:amadeus`, assign an office in the platform admin |
| "Open console" goes to a page that does not load | OTA admin not running on `PUBLIC_OTA_ADMIN_URL` | Start `ota/admin` on :3002 |
| Storefront links do not open locally | `*.ota.example.com` does not resolve | Use http://localhost:5173 (demo OTA) |
| Cookies missing over plain http | `__Host-` cookies need `Secure` | Use `http://localhost` (browsers treat it as secure), not a LAN IP |
| Sections missing (Custom domains, Live keys, Settlements…) | [[feature-switch]] off or the plan's limit is 0 | Turn the switch on and restart the API and worker; use a plan with the limit |
