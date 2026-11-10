# Velexis MVP tech stack

This document lists the exact technologies, versions and libraries of every Velexis component, each with a one-line reason, so that agents add the same dependencies the same way and nobody introduces a second library for a solved problem. It follows [`decisions.md`](decisions.md) and the [ADRs](adr/README.md). Where a line gives a major or minor version, the lockfile pins the exact patch, and Dependabot proposes updates weekly ([ADR-0002](adr/0002-monorepo-pnpm-turborepo.md)).

Related: [`architecture.md`](architecture.md) (where each piece runs), [`conventions.md`](conventions.md) (how to use them).

**Adding a dependency** that is not on this page needs a line in the PR description saying why the listed tools are not enough. A new kind of dependency (another framework, database or service) needs an ADR.

**Install scripts.** pnpm runs dependency install scripts only for the packages listed in `pnpm.onlyBuiltDependencies` of the root `package.json` (empty at M0). A task that adds a dependency whose install script is really needed (for example a native module without a prebuilt binary for Linux x64) adds it to that list in the same PR, with the reason in the PR description ([ADR-0023](adr/0023-release-artefact-and-deploy-user.md)).

## 1. Platform-wide versions

| Technology | Version | Why |
|---|---|---|
| Node.js | **22 LTS** (22.x, `.nvmrc`) | Product owner's choice. Long-term support until April 2027, built-in `fetch`, `require(esm)`. Plan the move to Node 24 LTS after the MVP. |
| pnpm | **9** (exact in `packageManager`) | Fast, strict workspaces; `pnpm deploy` builds self-contained app folders for the VM. |
| Turborepo | **2** (2.x) | Task graph and local caching across 17 workspace packages (six apps and the SDK, seven shared packages including the dev-only `@velexis/testing`, and the tools `@velexis/reference-data`, `@velexis/amadeus-stub`, `@velexis/e2e`; [ADR-0002](adr/0002-monorepo-pnpm-turborepo.md)). |
| TypeScript | **5.6** (5.6.x) | One compiler version for apps, packages and the SDK's `checkJs`. |
| PostgreSQL | **16** (16.x, PGDG apt) | The reference DDL was validated on 16 ([db README](../velexis-sdk/db/README.md)). |
| Redis | **7** (7.4.x, packages.redis.io apt) | BullMQ, caches, one-time tokens, rate limits. |
| Caddy | **2.8** (2.8.x, Caddy apt; later 2.x after reading the release notes) | Automatic HTTPS, on-demand TLS with an `ask` endpoint, simple reverse proxy ([ADR-0018](adr/0018-hosted-storefront-custom-domains.md)). |
| Ubuntu | **24.04 LTS** | Long support. Ships systemd 255. |
| systemd | 255 (Ubuntu's) | Process supervision, sandboxing, journald logs, timers ([ADR-0007](adr/0007-single-vm-without-docker.md)). |
| GitHub Actions | `actions/checkout` v4, `pnpm/action-setup` v5, `actions/setup-node` v4, `actions/cache` v4, `actions/upload-artifact` and `download-artifact` v4, each **pinned to a full commit SHA** with the tag in a comment | CI and manual deploys. Pinning keeps a moved tag from running new code next to the deploy key ([ADR-0023](adr/0023-release-artefact-and-deploy-user.md)). |

## 2. Libraries by concern

| Concern | Library | Version | Why |
|---|---|---|---|
| Backend framework | NestJS (`@nestjs/core`, `common`, `platform-express`) | **11** | Product owner's choice. Modules map to bounded contexts. Express 5 underneath. |
| Configuration | `@nestjs/config` + `@velexis/config` | 4.x | Loads env files. Our package validates them and the key files. |
| Logging | `pino` + `nestjs-pino` + `pino-http` | 9.x / 4.x / 10.x | Fast JSON logs with built-in redaction ([ADR-0016](adr/0016-observability.md)). |
| Request context | `nestjs-cls` | 5.x | AsyncLocalStorage for tenant, actor and `requestId` (db README §5). |
| Jobs | `bullmq` + `@nestjs/bullmq` | 5.x / 11.x | Queues, retries and schedulers on Redis ([ADR-0009](adr/0009-background-jobs-bullmq.md)). |
| Redis client | `ioredis` | 5.x | Required by BullMQ. Also used for caches and pub/sub. |
| Query builder | `kysely` | 0.28.x | Typed SQL without an ORM ([ADR-0005](adr/0005-data-access-kysely-sql-migrations.md)). |
| PostgreSQL driver | `pg` | 8.x | The standard driver. Kysely's `PostgresDialect`. |
| Table types | `kysely-codegen` | **0.20** (0.20.0 in `@velexis/db`, a devDependency: FIX-W46-SHARED, lead decision (11e) of 2026-11-06) | Generates table types from the migrated database. 0.20 takes `zod` 4 (4.6.7, the release of the forms row), so no `zod` 3 is left in the lockfile and `pnpm audit --audit-level high` is clean (0.18.5, the last 0.18.x, carried `zod` 3.25.76 with GHSA-mrhx-c7xc-m3w5). Its Node API (`generate`, `PostgresDialect`) and its output for our schemas are those of 0.18.5: `pnpm db:migrate && pnpm db:codegen` left `packages/db/src/generated` byte-identical when FIX-W46-SHARED moved to it. |
| OpenAPI types | `openapi-typescript` | 7.x | Generates `@velexis/api-types` from both documents ([ADR-0006](adr/0006-contract-first-openapi.md)). |
| OpenAPI lint | `@redocly/cli` | **2** (2.76.0 in `@velexis/api-types`: PBE-070) | Lints the documents. The OTA document was already validated with it. Since 2.34 the CLI is one bundled file without dependencies, so `pnpm audit` cannot see what it carries: its `THIRD_PARTY_NOTICES` lists the bundled releases (2.76.0: `undici` 7.30.1, `@faker-js/faker` 10.6.0, none with an advisory on 2026-11-06), and a new release is picked only after checking them. 2.x prints its problems on stdout and its progress on stderr, and its `recommended` rules add warnings (never errors) the 1.x rules did not have. 1.x carried `undici` 6.29.0 and `@faker-js/faker` 7.6.0 (security review F-5). |
| Typed HTTP client (portal, platform admin) | `openapi-fetch` | 0.13.x | Tiny, typed by the generated platform types. |
| Validation (API) | `ajv` + `ajv-formats` | 8.x / 3.x | Validates requests (runtime) and responses (tests) straight from the OpenAPI schemas. |
| Validation (forms) | `zod` | **4** (4.6.7 in the portal, the platform admin and the OTA admin: PFE-029, PAD-017, OAD-020) | Server-action form validation in the Next.js apps only ([ADR-0014](adr/0014-frontend-stack-nextjs-tailwind.md)). From 4.6.6 a list's `.max()` refuses an oversized list before any item is checked, so every list a server action parses carries the API's own limit; 3.x carried GHSA-mrhx-c7xc-m3w5 (security reviews F-4, OTA-SR-03). Zod 4 counts a string's `.min()` and `.max()` in code points, not UTF-16 units. |
| Passwords | `argon2` | 0.41+ | Argon2id with OWASP parameters ([ADR-0008](adr/0008-identity-accounts-customers-sessions.md)). |
| Tokens | `jose` | 5.x | EdDSA JWT signing and verification. Works from CommonJS. |
| MFA | `otplib` | 12.x | TOTP for portal and platform admin accounts. |
| MFA set-up QR code | `qrcode` | 1.5.x | Encodes the `otpauth://` URI of a TOTP set-up on the server of the Next.js apps (`lib/qr.ts`), so the secret never goes to a third-party QR service or a browser-side encoder; the page draws the answer as an inline SVG. Nothing else on this page encodes QR codes. |
| Encryption | Node `crypto` (built in) | — | AES-256-GCM envelope encryption, HMAC ([ADR-0010](adr/0010-secrets-envelope-encryption.md)). |
| Ids | `ulid` | 3.x | Prefixed ULID ids from a CSPRNG (db README §2.1). |
| Money | `decimal.js` | 10.x | Exact decimal arithmetic for prices, markups and fees. Never JS floats. |
| Dates | `date-fns` + `@date-fns/tz` | 4.x / 1.x | Deadline and time-zone arithmetic in backends. Formatting uses `Intl`. |
| Payments and billing | `stripe` (Node SDK) | 18.x, with `apiVersion` pinned in code | Billing, PaymentIntents, Connect, webhook verification ([ADR-0011](adr/0011-payments-stripe-and-airline-card.md), [ADR-0013](adr/0013-subscription-billing-stripe-billing.md)). |
| Amadeus HTTP | Node built-in `fetch` (undici) | — | No SDK dependency. A typed client in the OTA backend ([ADR-0012](adr/0012-amadeus-account-model.md)). |
| E-mail | `nodemailer` | **10** (10.3.1 in both backends and `@velexis/testing`: OBE-093, PBE-068) | SMTP to any provider. Mailpit in development ([ADR-0017](adr/0017-email-documents-storage.md)). Ships its own type declarations since 10.0, so no `@types/nodemailer`. The mailer gateways never let it read a file or a URL (`disableFileAccess`, `disableUrlAccess`) and send no `raw` message. 6.x carried five high advisories (security reviews OTA-SR-01, F-2). |
| E-mail templates | `handlebars` | 4.7.x | Logic-less, escaped by default, editable by OTAs. |
| PDF | `pdfmake` | 0.2.x | Pure JS PDFs. No headless browser on the VM. |
| HTTP hardening | `helmet`, `cookie-parser` | 8.x / 1.4.x | Security headers and cookie parsing in NestJS. |
| Rate limiting | `@nestjs/throttler` with a Redis storage | 6.x | Per-IP, per-key and per-tenant limits shared across processes. |
| Web framework | Next.js | **15** (15.x) | Product owner's choice for the portal, platform admin and OTA admin. App Router, `standalone` output. |
| UI library | React + React DOM | **19** (19.x) | Required by Next.js 15. Server components, `useActionState`. |
| CSS | Tailwind CSS (`tailwindcss`, `@tailwindcss/postcss`, `@tailwindcss/vite`) | **4** (4.1.x) | Product owner's choice for every UI. CSS-first configuration. |
| Components | shadcn/ui (`shadcn` CLI) + Radix primitives + `lucide-react` | CLI 2.x | Accessible components copied into each Next.js app. No runtime UI dependency to upgrade. |
| Tables | `@tanstack/react-table` | 8.x | shadcn data tables in the admin apps. |
| Storefront build | Vite | **6** (6.x) | Static multi-page build of the vanilla storefront, with Tailwind through `@tailwindcss/vite`. |
| SDK bundles | esbuild | 0.25.x | ESM and IIFE bundles of the SDK in milliseconds ([ADR-0019](adr/0019-vanilla-js-sdk-jsdoc.md)). |
| Unit and integration tests | Vitest | **4** (4.1.12 in every package and the root: PBE-070; the root `vitest.config.ts`) | Fast, one runner for Node, Next.js components and plain JS ([ADR-0015](adr/0015-testing-strategy.md)). Vitest 4 runs files in its own worker pool (no Tinypool, so `maxWorkers` replaces `poolOptions`), reads no workspace file (the root `vitest.config.ts`, named `vitest.workspace.ts` until 2026-11-06, holds the `test.projects` of every package's config and is passed with `--config`: [ADR-0002](adr/0002-monorepo-pnpm-turborepo.md) item 6), restores only `vi.spyOn` spies with `restoreMocks` (so every config that sets it also sets `mockReset`, which resets each `vi.fn()` before every test as `restoreMocks` did in 3.x) and types `ReturnType<typeof vi.fn>` as the mock of a function or a constructor, which cannot be called (type a mock that the code calls with `vi.fn<T>()` and `Mock<T>`). 3.x carried Tinypool 1.1.1 (two critical advisories, security review F-5). |
| HTTP tests | Supertest | 7.x | Drives a NestJS app in-process over HTTP. |
| DOM tests | `@testing-library/react`, `happy-dom` | 16.x / **21** (21.0.4 in the portal, the platform admin, the OTA admin, the storefront and the SDK: PBE-070) | React client components, and the storefront's DOM modules. happy-dom runs no `<script>` of a page unless asked (since 20.0) and caches its query results, so a `:checked` query can keep the radio checked before the group changed: the storefront reads checked inputs with `checkedInput()` of `lib/dom.js`. 17.x carried one critical and four high advisories (security review F-5). |
| End-to-end tests | Playwright + `@axe-core/playwright` | 1.6x / 4.x | Several origins, Stripe iframes, accessibility checks. |
| Lint | ESLint (flat config) + `typescript-eslint` + `@next/eslint-plugin-next` + `eslint-config-prettier` | **9** / 8.x / 15.x / 10.x | One root `eslint.config.mjs`. |
| Format | Prettier | 3.x | One formatting style. Not debated in reviews. |
| Webhook development | Stripe CLI | 1.x | `stripe listen --forward-to`, test events. |
| Local mail | Mailpit | 1.2x | SMTP sink with an API for tests. |
| Backups | `age`, `rclone` | 1.x / 1.6x | Encrypt dumps, copy them off the VM ([ADR-0007](adr/0007-single-vm-without-docker.md)). |
| Host security | `ufw`, `fail2ban`, `unattended-upgrades`, `auditd`, AIDE | Ubuntu packages | Firewall, SSH protection, patches, audit and file integrity (PCI controls in [ADR-0011](adr/0011-payments-stripe-and-airline-card.md)). |

## 3. Per component

### Platform backend (`platform/backend`, `@velexis/platform-backend`)

| Aspect | Choice |
|---|---|
| Runtime | Node.js 22, CommonJS output |
| Framework | NestJS 11 (Express 5), `@nestjs/config`, `nestjs-pino`, `nestjs-cls`, `@nestjs/bullmq` |
| Key libraries | `@velexis/db` (Kysely + pg), `@velexis/crypto`, `@velexis/errors`, `@velexis/api-types`, `ajv`, `argon2`, `jose`, `otplib`, `stripe`, `nodemailer`, `handlebars`, `ioredis`, `helmet`, `cookie-parser`, `@nestjs/throttler`, `decimal.js`, `ulid` |
| Test tools | Vitest, Supertest, Ajv response checks, signed Stripe fixture events, Mailpit |
| Build output | `dist/main.js` (API) and `dist/worker.js` (worker), packed with `pnpm deploy --prod` |
| Port | 3100 (API), 3101 (worker health) |

### Platform frontend (portal) (`platform/frontend`, `@velexis/platform-frontend`)

| Aspect | Choice |
|---|---|
| Runtime | Node.js 22 (Next.js server) |
| Framework | Next.js 15 App Router, React 19, TypeScript |
| Key libraries | Tailwind CSS 4, shadcn/ui, `lucide-react`, `openapi-fetch` + `@velexis/api-types/platform`, `zod`, `server-only`, `qrcode` (server side) |
| Test tools | Vitest + Testing Library (client components), Playwright journeys in `tools/e2e` |
| Build output | `.next/standalone` + `.next/static` + `public/` |
| Port | 3000 |

### Platform admin (`platform/admin`, `@velexis/platform-admin`)

| Aspect | Choice |
|---|---|
| Runtime | Node.js 22 (Next.js server) |
| Framework | Next.js 15 App Router, React 19, TypeScript |
| Key libraries | As the portal, plus `@tanstack/react-table` |
| Test tools | Vitest + Testing Library, Playwright |
| Build output | `.next/standalone` |
| Port | 3001 |

### OTA backend (`ota/backend`, `@velexis/ota-backend`)

| Aspect | Choice |
|---|---|
| Runtime | Node.js 22, CommonJS output |
| Framework | NestJS 11 (Express 5), `@nestjs/config`, `nestjs-pino`, `nestjs-cls`, `@nestjs/bullmq` |
| Key libraries | `@velexis/db`, `@velexis/crypto`, `@velexis/errors`, `@velexis/api-types`, `ajv`, `argon2`, `jose`, `stripe`, Node `fetch` (Amadeus), `nodemailer`, `handlebars`, `pdfmake`, `ioredis`, `helmet`, `cookie-parser`, `@nestjs/throttler`, `decimal.js`, `date-fns`, `ulid` |
| Test tools | Vitest, Supertest, Amadeus stub (`tools/amadeus-stub`), Ajv response checks, signed Stripe fixtures, Mailpit, two-tenant isolation tests |
| Build output | `dist/main.js`, `dist/worker.js`, `migrations/tenant/*.sql`, `openapi/*.yaml`, packed with `pnpm deploy --prod` |
| Port | 4000 (API), 4001 (worker health) |

### OTA frontend (storefront) (`ota/frontend`, `@velexis/ota-frontend`)

| Aspect | Choice |
|---|---|
| Runtime | Browser (evergreen, ES2022). No server process. |
| Framework | None: HTML pages + vanilla ES modules |
| Key libraries | `@velexis/ota-sdk` (cookie mode), Tailwind CSS 4 via `@tailwindcss/vite`, Stripe.js loaded from `js.stripe.com` on payment pages only, `Intl` for formatting |
| Test tools | Vitest + happy-dom (modules), Playwright + axe (pages) |
| Build output | `dist/` static files with hashed assets, served by Caddy from `/srv/velexis/current/storefront` |
| Port | none in production; Vite dev server 5173 (proxies `/api` to 4000 with a dev edge secret) |

### OTA admin (`ota/admin`, `@velexis/ota-admin`)

| Aspect | Choice |
|---|---|
| Runtime | Node.js 22 (Next.js server) |
| Framework | Next.js 15 App Router, React 19, TypeScript |
| Key libraries | `@velexis/ota-sdk` (server side, token mode), Tailwind CSS 4, shadcn/ui, `lucide-react`, `@tanstack/react-table`, `zod`, `server-only` |
| Test tools | Vitest + Testing Library, Playwright |
| Build output | `.next/standalone` |
| Port | 3002 |

### JS SDK (`ota/sdk`, `@velexis/ota-sdk`)

| Aspect | Choice |
|---|---|
| Runtime | Browsers (ES2022) and Node.js 22. Only platform APIs. |
| Framework | None. **No runtime dependencies.** |
| Key libraries | `@velexis/api-types` (types only, in JSDoc) |
| Test tools | Vitest with a fake `fetch`, `tsc --checkJs`, the contract check against `docs/velexis-sdk/sdk/src/` |
| Build output | `dist/velexis-sdk.mjs` (ESM), `dist/velexis-sdk.iife.js` (`window.Velexis`), `dist/types/*.d.ts` (esbuild + tsc). At most 25 KB min+gzip. |
| Port | none |

### Shared packages (`packages/*`)

| Aspect | Choice |
|---|---|
| Runtime | Node.js 22 (`@velexis/api-types` is also used for types in the SDK and the Next.js apps) |
| Build | `tsc -b` to `dist/` (CommonJS + `.d.ts`) |
| Test tools | Vitest; `@velexis/db` also has integration tests against PostgreSQL |

### Tools (`tools/*`)

| Tool | Choice |
|---|---|
| `tools/amadeus-stub` | Node `http` server, fixtures in JSON, request validation with Ajv against `docs/amadeus-api/*.json`. Port 4900. |
| `tools/e2e` | Playwright projects for the portal, OTA admin and storefront against a locally started stack. |
| `tools/plan-lint` | Plain Node script, no dependencies ([ADR-0020](adr/0020-ai-agent-development-workflow.md)). |

## 4. Deliberately not used

| Not used | Use instead | Reason |
|---|---|---|
| Docker on the VM | systemd units | Product owner's decision ([ADR-0007](adr/0007-single-vm-without-docker.md)) |
| Prisma, TypeORM, Drizzle | Kysely | ORM schemas would duplicate the reference DDL ([ADR-0005](adr/0005-data-access-kysely-sql-migrations.md)) |
| class-validator, class-transformer | Ajv on the OpenAPI schemas | One source of truth for shapes ([ADR-0006](adr/0006-contract-first-openapi.md)) |
| Jest | Vitest | Faster, one runner everywhere |
| Moment.js, Luxon | `Intl`, `date-fns` | Smaller, standard |
| Axios | `fetch` | Built into Node 22 and browsers |
| jQuery, Alpine, Lit (storefront) | Vanilla ES modules | Product owner's decision ([ADR-0014](adr/0014-frontend-stack-nextjs-tailwind.md)) |
| Puppeteer | pdfmake | Memory on a single VM ([ADR-0017](adr/0017-email-documents-storage.md)) |
| `express-session`, Passport | Our JWT + refresh-token guards | One mechanism matching the contract ([ADR-0008](adr/0008-identity-accounts-customers-sessions.md)) |
