# `@velexis/logger`

One logging setup for every Velexis Node process ([ADR-0016](../../docs/mvp/adr/0016-observability.md), [conventions §7](../../docs/mvp/conventions.md#7-logging-and-redaction)): pino JSON lines to stdout (journald on the VM), the standard fields, **the central redaction list**, an `err` serializer that never carries request or response bodies, the `pino-http` options of both backends, and the shared redactor for persisted payload copies ([db README §8](../../docs/velexis-sdk/db/README.md)).

## The rule

**Rule: a new sensitive field = a new path here plus a test.**

- Add the path to `REDACT_PATHS` in [`src/redact-paths.ts`](src/redact-paths.ts) at every depth it can appear (top level and `*.` at least), and keep the list ordered from shallow to deep.
- Add the case to [`src/redaction.test.ts`](src/redaction.test.ts) in the same pull request. There is no second list anywhere else.
- If the field also reaches a persisted payload copy, teach `redactPayload` about it in [`src/redact-payload.ts`](src/redact-payload.ts) and add a case to [`src/redact-payload.test.ts`](src/redact-payload.test.ts).

The list is a safety net, not a licence: never log request or response bodies, credential headers, tokens, passwords, card data, document numbers or decrypted secrets in the first place.

## Usage

```ts
import { createLogger, pinoHttpOptions, redactPayload, maskPan } from "@velexis/logger";

// One logger per process. LOG_LEVEL and APP_ENV come from the app's typed config (@velexis/config).
const logger = createLogger({ app: "ota-api", env: config.APP_ENV, level: config.LOG_LEVEL });

// NestJS (nestjs-pino stays in the apps): one line per request, requestId on every line of the request.
LoggerModule.forRoot({ pinoHttp: pinoHttpOptions({ app: "ota-api", logger }) });

// Event-style messages with fields.
logger.info({ bookingId, status }, "booking.created");
logger.error({ err }, "checkout.failed"); // err keeps type, message, stack, code and its cause chain only

// Before writing a payload copy to supplier_requests, order_snapshot, staff_actions, idempotency_keys, ...
const stored = redactPayload(supplierRequestBody); // deep copy: card number -> last 4, CVC dropped, tokens [REDACTED]

maskPan("4111111111111111"); // "411111******1111" (BIN + last 4, PCI truncation; ADR-0011)
```

Plain Node processes (workers, CLIs, the Next.js servers) use `createLogger` alone. Tests pass `destination` (any object with `write(line)`) to capture the lines.

## API

| Export | What it does |
|---|---|
| `createLogger({ app, env, level?, destination? })` | pino logger with base fields `app` and `env` (no `pid` or `hostname`), ISO `time`, level `info` by default, the serializers below and `REDACT_PATHS` with the censor `[REDACTED]`. |
| `serializeError` (the `err` serializer) | Keeps `type`, `message`, `stack` and `code` of the error and of every error in its `cause` chain (and the entries of an `AggregateError`). Everything else, including `body`, `data`, `request`, `response`, `config` and `headers`, is dropped, so an Amadeus or Stripe error never puts a body into a log line. A cause that is not an object keeps only its type. |
| `serializeErrorField`, `serializeRequest`, `serializeResponse`, `LOG_SERIALIZERS` | The serializers of the `error` (errors only), `req` (`id`, `method`, `route`) and `res` (`status`) keys. They never output headers, query strings or bodies. |
| `pinoHttpOptions({ app, logger })` | Options for `pino-http` / `nestjs-pino`. See below. |
| `resolveRequestId(header)`, `REQUEST_ID_PATTERN`, `REQUEST_ID_HEADER`, `isHealthPath(url)` | The request id rule and the health path rule used by `pinoHttpOptions`. |
| `REDACT_PATHS`, `REDACT_CENSOR` | The single redaction list and its censor `[REDACTED]`. |
| `redactPayload(value)`, `CIRCULAR_REFERENCE` | The shared redactor for persisted payload copies, and the `[Circular]` marker it puts in place of a reference back to an enclosing object. See below. |
| `maskPan(pan)` | BIN and last 4 digits of a card number; shorter values keep at most the last 4 digits. |

### `pinoHttpOptions`

- **Request id:** a valid incoming `X-Request-Id` (`^[A-Za-z0-9._-]{8,128}$`, the same rule as the [Caddyfile](../../deploy/caddy/Caddyfile)) is kept, anything else is replaced by `crypto.randomUUID()`. The id is set as `req.id`, returned in the `X-Request-Id` response header, and bound as `requestId` to `req.log`, so every line logged during the request carries it. Use `req.id` for the error envelope and the request context.
- **One line per request** when the response finishes: `method`, `route` (the Express route template, such as `/v1/bookings/:bookingId`, or the path without its query string when no route matched), `status` and `durationMs`. Level `error` (with `err`) for 5xx responses and failed requests, `info` otherwise. A response that carries `res.err` (as nestjs-pino's `LoggerErrorInterceptor` sets it) also gets the serialized `err`, at level `info` below 500.
- **Never** headers, query strings or bodies: the request and response objects are not bound to the logger, and the `req`/`res` serializers keep only the fields above.
- **`/health` and `/health/*`** requests are not logged.
- The `app` must match the logger's `app`; a logger without one gets it as a child binding.

### `redactPayload`

Returns a deep copy and never mutates its input. Keys are matched without regard to case, `-` or `_`.

| Field | Result |
|---|---|
| `number` under `card`, `creditCard`, `paymentCard`, `virtualCreditCardDetails` (also a bare card number as the value of `card`) | last 4 digits |
| `number` under `documents[]` or `document`; `cardNumber`, `certificateNumber` anywhere (Amadeus `discountEligibility`) | last 4 characters |
| `securityCode`, `cvc`, `cvv`, `cvv2`, `birthPlace`, `issuanceLocation` | dropped |
| Any key containing `password`, `passphrase`, `token`, `secret` or `apiKey`; `authorization`, `cookie`, `set-cookie`, `mfaCode`, `x-velexis-edge`, `stripe-signature` | `[REDACTED]` |
| The platform's bank numbers and MFA material (platform architecture §8): `iban`, `accountNumber`, `recoveryCode`, `recoveryCodes`, `otpauthUrl`, and the e-mail links with tokens `verifyUrl`, `resetUrl`, `acceptUrl` (`secretKey`, `webhookSecret`, `totpSecret`, `mfaChallengeToken`, `invitationToken` and `secretData` are caught by the fragments above) | `[REDACTED]` |
| `code` and `state` anywhere below an `mfa` or `oauth` key (an MFA or OAuth body); every other `code` (error codes) stays | `[REDACTED]` |
| Arrays, nested objects, values with `toJSON` | handled recursively (as `JSON.stringify` would see them) |
| A reference back to an enclosing object | `[Circular]` |

## The redaction list

`REDACT_PATHS` holds, in pino path syntax:

- `password`, `newPassword`, `currentPassword`, `mfaCode`, `accessToken`, `refreshToken`, `portalToken`, `bookingToken`, `token`, `clientSecret`, `secret`, `apiKey`, `securityCode`, `cvc`, `cardNumber`, `certificateNumber` at the top level and one level down (`*.password`);
- the platform's keys of [platform architecture §8](../../platform/docs/architecture.md#8-security-notes-specific-to-the-platform), at the top level and one level down: `secretKey`, `webhookSecret` (Stripe), `iban`, `accountNumber` (payout accounts), `recoveryCode`, `recoveryCodes`, `totpSecret`, `otpauthUrl`, `mfaChallengeToken` (MFA), `invitationToken`, `secretData` (the secret variables of a platform e-mail, PBE-011) and the links with tokens those variables hold, `verifyUrl`, `resetUrl` and `acceptUrl`;
- `code` and `state` of an MFA or OAuth body: `mfa.code`, `mfa.state`, `oauth.code`, `oauth.state` and the same one level down (`*.mfa.code`). pino paths cannot look at a sibling key, and a bare `code` is the error code of every `err` and error envelope, so the platform logs a `verifyMfa`, `stepUp`, `enableMfa` or `completeStripeConnect` body, if ever, under the key `mfa` or `oauth`, never under a generic key;
- `*.card.number`, `*.creditCard.number`, `documents[*].number`, `*.documents[*].number`;
- the whole `card`, `creditCard` and `formOfPayments` objects at the top level and at every nesting depth down to depth 8 (`card`, `*.card`, …, `*.*.*.*.*.*.*.card`). pino paths are not recursive, and an Amadeus Create Orders body logged at depth 1 to 6 has its `formOfPayments` at depth 3 to 8;
- `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `req.headers["x-api-key"]`, `req.headers["x-csrf-token"]`, `req.headers["x-booking-token"]`, `req.headers["x-velexis-edge"]`, `req.headers["x-velexis-bff-key"]` (the platform's first-party key of the portal and admin servers, PADR-0019).

Keep it ordered from shallow to deep: pino applies the paths in order, and censoring an object before a deeper wildcard path reaches it keeps pino from walking into the original object.

Known upstream limit (pino 9.14 with `@pinojs/redact` 0.4.0): below a key that also starts a literal path (`documents`, `mfa` and `oauth` at depth 1 or 2, and `req.headers` / `res.headers` when the `req` and `res` serializers are replaced), pino copies only along that literal path. A `card`, `creditCard` or `formOfPayments` object nested inside such a branch still stays out of the line, but the censor is also written into the caller's object. Identity documents, MFA and OAuth bodies and header strings never nest card objects, and the tests check that realistic logged objects stay unchanged.

Every path costs time on every line: about 0.1 ms per line with this list, against a few microseconds without redaction. Log events, not loops.

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter @velexis/logger build` | `tsc -b` to `dist/` (CommonJS and declarations) |
| `pnpm --filter @velexis/logger test` | Unit tests (Vitest) |
| `pnpm --filter @velexis/logger typecheck` / `lint` | `tsc --noEmit` / ESLint |
