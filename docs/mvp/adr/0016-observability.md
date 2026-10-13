# ADR-0016: Observability

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Lead architect. Decided during planning; revisit when a second VM, a managed database, or more than one person on call makes a hosted log and metrics service worth its cost.
**Revisions:** 2026-10-12 (planning review): card objects are censored at every depth and bodies never reach the `err` serializer; security logs are kept 12 months off the VM ([ADR-0027](0027-pci-scope-and-vm-controls.md)).

## Context

One developer runs seven Node processes, PostgreSQL, Redis and Caddy on one VM ([ADR-0007](0007-single-vm-without-docker.md)). They need to:

- know quickly when something is down or failing;
- trace one customer complaint ("my booking failed") through the logs;
- never leak secrets, tokens or card data into those logs ([ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0011](0011-payments-stripe-and-airline-card.md)).

M6 includes "monitoring and alerting". The stack must be cheap and simple to run.

## Decision

### Logs

- **pino** JSON logs to stdout in every Node process. In NestJS through `nestjs-pino`; in the Next.js servers through `@velexis/logger` in server code.
- systemd sends stdout to **journald**. Retention: `SystemMaxUse=4G`, 30 days. Security logs (auditd, sshd, sudo, Caddy, app security events) are also kept 3 months on the VM and shipped off the VM with 12-month retention and a daily automated review (task X-038, [ADR-0027](0027-pci-scope-and-vm-controls.md)).
- **Standard fields:** `time`, `level`, `app`, `env`, `requestId`, `tenantId`, `tenantKey`, `environment` (test or live), `actorType`, `actorId`, `route`, `operationId`, `status`, `durationMs`, `err` (type, message, stack, code).
- **Request id:**
  - Caddy sets `X-Request-Id` (`{http.request.uuid}`) when the client did not send a valid one;
  - the backends accept it, put it in the AsyncLocalStorage context (`nestjs-cls`), return it in responses and in the error envelope `requestId`;
  - it is passed to queue messages and to `supplier_requests`.
- **What is logged:** one line per HTTP request (method, route template, status, duration); one per Amadeus and Stripe call (operation, status, duration, error codes); job start, finish and failure; security events (sign-in failures, lockouts, permission denials, rate-limit hits).
- **What is never logged:**
  - request or response bodies (outside `debug` in local development, and never on the airline-card route);
  - headers `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-csrf-token` and the first-party service headers;
  - any value at the redaction paths below.
- **Redaction list** in `@velexis/logger`, shared by every app, with unit tests:
  - `password`, `newPassword`, `currentPassword`, `mfaCode`;
  - `accessToken`, `refreshToken`, `portalToken`, `bookingToken`, `token`, `clientSecret`, `secret`, `apiKey`;
  - `number` (any field named `number` under `card`, `creditCard` or `documents`), `securityCode`, `cvc`, `cardNumber`, `certificateNumber`;
  - the whole `card`, `creditCard` and `formOfPayments` objects, at every depth the apps log (pino paths are not recursive, so each depth is spelt out, plus a censor that walks error causes);
  - `authorization`, `cookie`.
- The `err` serializer keeps type, message, stack and `code`, and never request or response bodies (an Amadeus or Stripe error's body can hold card data).
- **Tests** assert that a log line produced from a request containing a test PAN, a password and a token contains none of them, and that an error carrying a nested Amadeus Create Orders body logs neither the PAN nor the CVV.

### Health

- Every Node process exposes:
  - `GET /health/live`: the process is up.
  - `GET /health/ready`: PostgreSQL and Redis are reachable. Backends also report the age of the oldest waiting job per queue.
- Workers expose the same endpoints on their health-only ports (3101, 4001).
- Caddy blocks `/health/*` from the internet except `/health/live` on the API hosts.

### Metrics and alerting (MVP level)

- **External uptime monitor** (any HTTP checker service, free tier) polls once a minute:
  - `https://api.platform.example.com/health/live`;
  - `https://api.ota.example.com/health/live`;
  - the portal;
  - one demo storefront.
  It alerts by e-mail and push.
- **On-VM check** (`velexis-healthcheck.timer`, every 5 minutes, a shell script in `deploy/scripts/`) checks:
  - every unit's `/health/ready`;
  - disk use above 80 %;
  - Redis memory above 70 % of `maxmemory`;
  - the age of the last successful backup (over 26 hours);
  - failed BullMQ jobs in the last hour above a threshold;
  - TLS certificate expiry for the main hosts;
  - the PCI payment-page integrity result ([ADR-0011](0011-payments-stripe-and-airline-card.md)).
  It sends an e-mail to the operator through the configured SMTP when something fails.
- systemd `OnFailure=` on every unit sends the same alert when a unit enters `failed`.
- **Error tracking (optional):** the backends and Next.js apps initialise Sentry only when `SENTRY_DSN` is set, with the same redaction applied in `beforeSend`. It is off by default.
- **Business visibility** comes from the database, not from a metrics store. The platform admin shows provisioning jobs, failed jobs and per-tenant counts (M1). The OTA admin shows `supplier_requests` diagnostics (M4).

### Audit (not logs)

`platform.platform_audit_log` and the tenant `staff_actions` table are the audit trails (db README §8). They are append-only database tables, not log lines, and are kept with the data.

## Consequences

### Positive

- Nearly free to run, with no extra service on the VM.
- One `requestId` connects the browser error, the API log line, the Amadeus call and the `supplier_requests` row.
- Redaction is central and tested, which is what PCI and GDPR need.

### Negative

- No dashboards or historical metrics. Questions about trends need ad-hoc `journalctl` and SQL.
- The on-VM checker shares the VM's fate. The external uptime monitor covers a dead VM.

### Follow-ups

- When revisiting: OpenTelemetry traces and metrics to a hosted backend, or Prometheus and Grafana on a separate small VM.

## Alternatives considered

- **Prometheus + Grafana + Loki on the same VM.** Heavy for 8 GB of RAM and another thing to maintain.
- **A hosted APM from day one.** Cost and data-processing questions before there is traffic.
- **Plain `console.log`.** No structure, no redaction.

## References

- [ADR-0007](0007-single-vm-without-docker.md), [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0011](0011-payments-stripe-and-airline-card.md)
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §8 (audit, redaction)
- [`../conventions.md`](../conventions.md) (logging and redaction)
