# PCI evidence: the storefront's script inventory

PCI DSS v4.0.1 requirement **6.4.3** asks that every script loaded and run in the consumer's browser on a payment page is managed: each one is authorised, its integrity is assured, and an inventory lists every script with a written justification of why it is needed. Requirement **11.6.1** asks for a mechanism that alerts on an unauthorised change to the security-relevant HTTP headers and the script contents of the payment pages as the browser receives them, at least weekly. This document is the evidence for both on the hosted storefront (task OFE-023, the on-VM check of X-030, [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C, [OADR-0017](../adr/0017-airline-card-form-isolation.md) point 8). It is part of the [PCI evidence pack](README.md).

It does not copy the inventory itself. The inventory is a file the build writes, with the SHA-256 of every first-party script, and those hashes change with every build: a copy here would be wrong after the next release. This document says where the file is, what it holds, how each script is authorised and checked, and what risk remains.

References follow the convention of [`data-flow.md`](data-flow.md): a link named `file:line` and, after it, a piece of that line in code style.

## 1. The inventory and where it lives

| What | Where |
|---|---|
| The generator, run after `vite build` | [`payment-page-inventory.mjs`](../../frontend/scripts/payment-page-inventory.mjs) of the storefront |
| The reviewed lists the build enforces | Every page with its purpose: [`payment-page-inventory.mjs:54`](../../frontend/scripts/payment-page-inventory.mjs#L54) `export const PAGE_PURPOSES`; the only third-party script with its justification: [`payment-page-inventory.mjs:84`](../../frontend/scripts/payment-page-inventory.mjs#L84) `export const THIRD_PARTY_SCRIPTS`; the two payment pages: [`payment-page-inventory.mjs:44`](../../frontend/scripts/payment-page-inventory.mjs#L44) `export const PAYMENT_PAGES` |
| The file | `dist/payment-page-inventory.json` of `ota/frontend`; in the release `storefront/payment-page-inventory.json` ([`pack-release.sh:97`](../../../deploy/scripts/pack-release.sh#L97) `cp -a ota/frontend/dist`); on the VM `/srv/velexis/current/storefront/payment-page-inventory.json`; served by Caddy at `/payment-page-inventory.json` of every storefront |
| Its format (version 1) | The storefront README, [§10 Security](../../frontend/README.md#10-security): the fields table (`pages[].scripts[]` in document order with `firstParty`, `sha256`, `purpose` and the `justification` of a third-party script; `modulePreloads[]`, `firstPartyScripts[]` with every chunk a page can run, `stylesheets[]`, and `headers` per path) |
| The purpose of each page and its scripts | The same section's table "The scripts and their purpose", kept equal to `PAGE_PURPOSES` by [`payment-page-inventory.test.js:278`](../../frontend/test/payment-page-inventory.test.js#L278) `README §10 documents every page of the inventory` |

To give an assessor the inventory of a release, take the file from the release (or build the commit) and print it, for example:

```bash
pnpm --filter @velexis/ota-frontend build
jq -r '.pages[] | "\(.path)\tpayment=\(.payment)\t\(.purpose)"' ota/frontend/dist/payment-page-inventory.json
jq -r '.pages[] | .path as $p | .scripts[] | "\($p)\t\(.src)\tfirstParty=\(.firstParty)\t\(.sha256 // "by URL")\t\(.purpose)"' \
  ota/frontend/dist/payment-page-inventory.json
jq -r '.pages[] | select(.payment) | .firstPartyScripts[] | "\(.sha256)  \(.src)"' ota/frontend/dist/payment-page-inventory.json
```

## 2. Every page of the storefront origin

The inventory covers **every** page of the build, not only the two payment pages: any script on the storefront origin could draw a look-alike card form or try to reach the card page ([OADR-0017](../adr/0017-airline-card-form-isolation.md) point 8, §5 below). The build has 20 pages. Each one runs exactly one first-party entry bundle of its own, `/assets/<entry>-<hash>.js`, built from `src/pages/<entry>.js` of this repository, plus the shared first-party chunks it preloads; the only third-party script is Stripe.js on the card page. The link of each row is the page's entry in `PAGE_PURPOSES`, where its purpose is written.

| Page (file) | Payment page | Scripts, in document order |
|---|---|---|
| [`checkout/pay-card.html`](../../frontend/scripts/payment-page-inventory.mjs#L69) `[CARD_PAGE]: "Card payment` | **yes** | Stripe.js `https://js.stripe.com/v3/` (third-party), then its own bundle |
| [`checkout/pay-airline.html`](../../frontend/scripts/payment-page-inventory.mjs#L67) `[AIRLINE_CARD_PAGE]` | **yes** | Its own bundle only, one file that imports nothing (no module preload) |
| [`index.html`](../../frontend/scripts/payment-page-inventory.mjs#L71) `"index.html": "Home` | no | Its own bundle |
| [`search.html`](../../frontend/scripts/payment-page-inventory.mjs#L76) `"search.html"` | no | Its own bundle |
| [`offer.html`](../../frontend/scripts/payment-page-inventory.mjs#L73) `"offer.html"` | no | Its own bundle |
| [`price.html`](../../frontend/scripts/payment-page-inventory.mjs#L75) `"price.html"` | no | Its own bundle |
| [`checkout.html`](../../frontend/scripts/payment-page-inventory.mjs#L64) `"checkout.html"` | no | Its own bundle |
| [`checkout/complete.html`](../../frontend/scripts/payment-page-inventory.mjs#L66) `"checkout/complete.html"` | no | Its own bundle; no Stripe.js |
| [`confirmation.html`](../../frontend/scripts/payment-page-inventory.mjs#L70) `"confirmation.html"` | no | Its own bundle |
| [`bookings.html`](../../frontend/scripts/payment-page-inventory.mjs#L63) `"bookings.html"` | no | Its own bundle |
| [`booking.html`](../../frontend/scripts/payment-page-inventory.mjs#L62) `"booking.html"` | no | Its own bundle |
| [`lookup.html`](../../frontend/scripts/payment-page-inventory.mjs#L72) `"lookup.html"` | no | Its own bundle |
| [`account/index.html`](../../frontend/scripts/payment-page-inventory.mjs#L57) `"account/index.html"` | no | Its own bundle |
| [`account/sign-in.html`](../../frontend/scripts/payment-page-inventory.mjs#L59) `"account/sign-in.html"` | no | Its own bundle |
| [`account/sign-up.html`](../../frontend/scripts/payment-page-inventory.mjs#L60) `"account/sign-up.html"` | no | Its own bundle |
| [`account/verify.html`](../../frontend/scripts/payment-page-inventory.mjs#L61) `"account/verify.html"` | no | Its own bundle |
| [`account/forgot-password.html`](../../frontend/scripts/payment-page-inventory.mjs#L56) `"account/forgot-password.html"` | no | Its own bundle |
| [`account/reset-password.html`](../../frontend/scripts/payment-page-inventory.mjs#L58) `"account/reset-password.html"` | no | Its own bundle |
| [`p.html`](../../frontend/scripts/payment-page-inventory.mjs#L74) `"p.html"` | no | Its own bundle (the OTA's content pages `/p/<slug>`, built from blocks with `createElement`, never from HTML) |
| [`404.html`](../../frontend/scripts/payment-page-inventory.mjs#L55) `"404.html"` | no | Its own bundle |

The build refuses a page that is not in `PAGE_PURPOSES` and a listed page that is missing ([`payment-page-inventory.test.js:460`](../../frontend/test/payment-page-inventory.test.js#L460) `a page that is not in the reviewed list fails`), so this table can only grow through a reviewed change of that list and of the storefront README. At each review of the pack, compare the table with the first `jq` command of §1.

## 3. How each script is authorised and its integrity assured (6.4.3)

| | First-party scripts (every entry bundle and shared chunk) | Stripe.js (card page only) |
|---|---|---|
| **Why it is needed** | The page's own code: forms, the SDK calls, rendering. Each page's purpose is in `PAGE_PURPOSES` and the storefront README §10 | Card payments through Stripe (method (a), [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §A): it mounts Stripe's Payment Element, whose iframes on Stripe's origin collect the card, and runs 3-D Secure. The justification is written in the inventory itself: [`payment-page-inventory.mjs:92`](../../frontend/scripts/payment-page-inventory.mjs#L92) `"Required for card payments through Stripe` |
| **Authorised by** | The repository's change control: every change is a reviewed pull request, built by the deploy workflow's build job and deployed behind the `production` environment ([`data-flow.md`](data-flow.md) §3, change control). The build fails on an inline script, a third-party script, module preload, stylesheet or chunk import that `THIRD_PARTY_SCRIPTS` does not list, a `<script>` or `<link>` inside an HTML comment, and a file missing from the build ([`payment-page-inventory.test.js:349`](../../frontend/test/payment-page-inventory.test.js#L349) `a third-party script on any page but the card page`, [`:395`](../../frontend/test/payment-page-inventory.test.js#L395) `third-party code through a module preload, a stylesheet or a chunk's import fails too`, [`:418`](../../frontend/test/payment-page-inventory.test.js#L418) `a commented <script> or <link> fails`, [`:447`](../../frontend/test/payment-page-inventory.test.js#L447) `an inline script or a file missing from the build fails`) | Its entry in `THIRD_PARTY_SCRIPTS`, for the card page alone: anywhere else, or a card page without it, fails the build ([`payment-page-inventory.test.js:379`](../../frontend/test/payment-page-inventory.test.js#L379) `Stripe.js anywhere but the card page fails`). Adding a third-party script means changing that list and the CSP of the Caddyfile in a reviewed pull request |
| **What else may run** | The CSP allows scripts only from the storefront origin and Stripe's hosts, with no inline script ([`Caddyfile:244`](../../../deploy/caddy/Caddyfile#L244) `script-src 'self' https://js.stripe.com`), and only from the storefront origin on the airline-card page ([`Caddyfile:276`](../../../deploy/caddy/Caddyfile#L276) `script-src 'self'; connect-src 'self'`) | The same CSP limits Stripe.js to Stripe's hosts for scripts and frames, and `connect-src` to `api.stripe.com` |
| **Integrity** | The SHA-256 of every first-party script and stylesheet a page can run, in the inventory ([`payment-page-inventory.test.js:230`](../../frontend/test/payment-page-inventory.test.js#L230) `hashes every first-party script a page can run`), compared daily with what Caddy serves (§4) | Not hashable: Stripe serves it only from `js.stripe.com` and changes it without notice, so neither a hash nor Subresource Integrity can pin it. Its integrity rests on TLS to Stripe, the CSP above, the daily comparison of its URL, its place before the page's bundle and the card page's HTML and headers (§4), and Stripe's own PCI DSS responsibility for the script ([`responsibility-matrix.md`](responsibility-matrix.md) §3) |

## 4. The change and tamper check (11.6.1)

The on-VM health check (X-030, [deployment-single-vm.md §13](../../../docs/mvp/deployment-single-vm.md#13-monitoring-and-uptime)) compares the live pages with the inventory of the current release once per UTC day, more often than the weekly minimum of 11.6.1:

- **What it fetches.** Each page of one storefront, `HEALTHCHECK_STOREFRONT_HOST` (by default the demo storefront `demo.<STOREFRONT_BASE_DOMAIN>`, [`healthcheck.sh:575`](../../../deploy/scripts/healthcheck.sh#L575) `HEALTHCHECK_STOREFRONT_HOST)"`): every storefront, on a sub-domain or a custom domain, serves the same files of the release with the same headers, because both site blocks import the one `(storefront)` snippet ([`Caddyfile:473`](../../../deploy/caddy/Caddyfile#L473) `*.{$STOREFRONT_BASE_DOMAIN:ota.example.com} {`, [`Caddyfile:481`](../../../deploy/caddy/Caddyfile#L481) `https:// {`). It fetches them through this VM's Caddy with that real host name (TLS, SNI, certificate check), so it sees what a browser receives; only the URLs of the inventory, never one found in a page; without `Accept-Encoding`, because the inventory hashes the stored files ([`healthcheck.sh:27`](../../../deploy/scripts/healthcheck.sh#L27) `payment-page-<page>`).
- **What it compares.** The ordered `<script src>` list and the module preloads, the absence of inline scripts, the HTML's SHA-256, every header of the inventory on every path of the page (the CSP, COOP, `Cache-Control`, HSTS and the others), then the SHA-256 of every first-party script and stylesheet the page loads ([`healthcheck.sh:523`](../../../deploy/scripts/healthcheck.sh#L523) `check_page()`). A missing inventory skips the check with a warning; an inventory of another format or version fails it.
- **Which pages.** The two payment pages by default, as PCI DSS 11.6.1 and ADR-0011 §C ask; every page of the inventory with `HEALTHCHECK_PAGES=all` in `/etc/velexis/healthcheck.env` ([`healthcheck.sh:599`](../../../deploy/scripts/healthcheck.sh#L599) `if [ "$scope" = all ]`; lead decision (10g) of 2026-11-06). [OADR-0017](../adr/0017-airline-card-form-isolation.md) point 8 asks for every page (the request is in the [OTA ADR index](../adr/README.md#requests-from-the-storefront-sdk-and-ota-admin-adrs-to-other-parts)); the M6 review (OBE-086) decides whether production runs with `all`.
- **The alert.** A page whose check goes from ok to failing sends one e-mail through `velexis-alert` naming the page and the script or header that differs, and one when it recovers ([`healthcheck.test.sh:657`](../../../deploy/scripts/test/healthcheck.test.sh#L657) `health check failed: payment page /checkout/pay-card.html: script`). What to do then: [`incident-response.md`](incident-response.md) §4.2.
- **During a deploy.** While `velexis-deploy` holds its lock the check waits for the next run, because a deploy switches the release and may reload Caddy.

Status: built and tested ([`healthcheck.test.sh:601`](../../../deploy/scripts/test/healthcheck.test.sh#L601) `both payment pages, the second path of the airline-card page and every first-party script and stylesheet are fetched`); the check on the production VM, with a real alert received, is X-030's human step.

## 5. Residual risk of the shared origin (OADR-0017)

The airline-card page shares its origin with every other storefront page: the card page that loads the third-party Stripe.js, and the OTA-managed content pages `/p/*`.

- **What stops another page from reading the real card page.** `Cross-Origin-Opener-Policy: same-origin` on the airline-card page alone, so a window that another page opens on it gets a closed handle ([`checkout-airline-card.e2e.ts:405`](../../../tools/e2e/specs/storefront/checkout-airline-card.e2e.ts#L405) `gets a closed handle and no access to it`); `frame-ancestors 'none'`, so no page can frame it; `worker-src 'none'` on every page, so no script can register a service worker in front of it; and the page reads nothing that other pages can write (ids from its URL, the rest from the API).
- **What remains.** A malicious or compromised script on any page of the origin could still draw a look-alike card form, or send the visitor elsewhere. That is why the whole origin is in the inventory, the build refuses unreviewed code on every page, the content pages are built from blocks without HTML or scripts, and the daily check can cover every page.
- **What the M6 review decides.** [OADR-0017](../adr/0017-airline-card-form-isolation.md) leaves it to the review before live airline-card payments (OBE-086): accept this risk, or build a dedicated card-entry origin (its "Alternatives considered"). Record the decision and its date in the [README](README.md#6-review-record).
- **A compromised release.** The daily check detects a change outside a deploy, not a malicious release: a supply-chain attack on the build would ship a changed script with a matching inventory. The mitigations are the reviewed dependency updates, no dependency install scripts, the airline-card page's single small bundle (30 KB of JavaScript at most) and the code review of every change.
