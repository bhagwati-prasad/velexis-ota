# PADR-0019: End-user IP forwarding from the portal and admin servers

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead (planning review). Decided during planning; revisit when the portal or the admin moves to another host, when a proxy other than the local Caddy sits in front of them, or when a third party calls the platform API.

## Context

The portal and the platform admin are backends-for-frontends. Browsers never call the platform API. The Next.js servers call it from `127.0.0.1` ([PADR-0009](0009-platform-api-surface-and-authentication.md) point 3). The API uses the client IP for two things:

- **Rate limits per IP** ([`../api-inventory.md`](../api-inventory.md) §2): sign-up 5 per IP per hour, sign-in and admin sign-in 10 per IP per minute, reset and resend 10 per IP per hour, invitation lookup 20 per IP per hour.
- **Records**: `platform_audit_log.ip_address` and `user_agent` ([PADR-0006](0006-platform-admin-access-and-audit.md)), `account_sessions` (the session list shows the device) and `account_tokens.ip_address`.

Nothing passed the browser's IP from the Next.js servers to the API. Every portal user would then share one throttler bucket keyed on `127.0.0.1`. Ten bad sign-in attempts a minute from anyone would lock out every sign-in, admin sign-in included. Audit rows would record the portal server instead of the person.

The API cannot simply trust `X-Forwarded-For`. Express's `trust proxy` is set to loopback so that Caddy's header is honoured for public calls (webhooks), and the portal also connects from loopback. A browser can send any `X-Forwarded-For` to the portal, so the portal must not pass its own incoming header through unchanged.

The OTA side solved the same problem with a first-party secret from known local callers: `X-Velexis-Edge` for Caddy, a service key for the OTA admin, and `X-Velexis-End-User-IP` for servers with secret keys.

## Decision

1. **Where the BFF gets the IP.** The portal and admin servers listen only on `127.0.0.1` behind Caddy. Caddy 2.8 has no trusted proxies configured, so it replaces any client-supplied `X-Forwarded-For` with the real client address (the WAF of X-039 runs inside Caddy and does not change this). `lib/api.ts` takes the **right-most** `X-Forwarded-For` entry. With no header (local development without Caddy) it uses `127.0.0.1`. The user agent is the browser's `User-Agent`, cut to 512 characters.
2. **How it reaches the API.** Every call from `lib/api.ts`, including the refresh made by `middleware.ts`, sends three headers:

   | Header | Value |
   |---|---|
   | `X-Velexis-Bff-Key` | `PLATFORM_BFF_KEY`, a random secret of at least 32 bytes shared by the API, the portal and the admin |
   | `X-Velexis-End-User-IP` | The IP of point 1 |
   | `X-Velexis-End-User-Agent` | The user agent of point 1 |

3. **When the API honours them.** The request-context middleware uses the two end-user headers only when **all** of these hold: the socket peer is loopback, the request has **no** `X-Forwarded-For` (so it did not come through Caddy), and `X-Velexis-Bff-Key` matches `PLATFORM_BFF_KEY` in constant time. A request with a valid key but a missing or invalid IP (`net.isIP` is 0) answers `400 VALIDATION_FAILED`, so a client bug cannot quietly put everyone back in one bucket. Otherwise the headers are ignored, a wrong key is logged as a warning without its value, and the IP is Express's `req.ip`.
4. **Who uses the result.** The throttler's tracker, `AuditService`, session and token rows read only the request-context IP and user agent, never `req.ip` or the raw headers.
5. **Configuration.** `PLATFORM_BFF_KEY` is a new variable in `platform-backend.env`, `platform-frontend.env` and `platform-admin.env`. `provision-vm.sh` generates it once, as it does `OTA_ADMIN_SERVICE_KEY`. Development uses a dummy value in the three `.env.example` files. `x-velexis-bff-key` joins the logger's redaction list.
6. **Tests.** Two calls with the valid key and different forwarded IPs get separate sign-in buckets. A call with a forged key, or one sent through Caddy (with `X-Forwarded-For`), is throttled and audited by its socket or Caddy IP. A valid key without an IP answers 400. The portal and admin unit tests check that the right-most entry is chosen and that a browser-supplied left-most entry is ignored.

## Consequences

### Positive

- Per-IP limits work per person again, and one attacker cannot lock out every sign-in.
- Audit, session and token rows show the person's IP and device.
- It follows the OTA pattern (a first-party secret from known local callers), so there is one mental model.

### Negative

- One more shared secret to generate and rotate. Rotation needs the three services restarted together. A short window of 400s or shared-bucket fallbacks is acceptable at MVP scale.
- The portal and admin share one key. A compromised portal server could forge IPs on admin calls. It still could not authenticate as an admin, and the admin keeps MFA and its own throttles.
- The design depends on Caddy replacing `X-Forwarded-For`. Adding trusted proxies (a CDN or an external WAF) must revisit point 1.

### Follow-ups

- PBE-008 builds the request-context rule and its tests, PBE-009 keys the throttler on it, and PFE-002 and PAD-002 send the headers. PBE-062's rate-limit tests run through the forwarded IP.
- `provision-vm.sh` and the three `deploy/env/` templates gain `PLATFORM_BFF_KEY` in the same pull request as PBE-008, as do the configuration matrix and the root `.env.example` ([`conventions.md` §8](../../../docs/mvp/conventions.md#8-configuration)).

## Alternatives considered

- **Trust `X-Forwarded-For` from loopback.** The portal is on loopback too, so a browser could choose its own IP through it. Passing the portal's incoming header through unchanged gives the same hole.
- **A separate listener (port) for the BFFs.** It needs no shared secret, but adds a second listener, Caddy rules that must never route to it, and a systemd hardening exception. That is more moving parts for one developer than a header and a secret.
- **Throttle in the Next.js servers instead.** That gives two throttlers, and the API would still record the wrong IP in audit rows and sessions.
- **Per-account limits only.** Sign-up, sign-in and invitation lookup have no account yet, or would let an attacker lock any known account.

## References

- [PADR-0009](0009-platform-api-surface-and-authentication.md) point 10, [PADR-0006](0006-platform-admin-access-and-audit.md), [`../api-inventory.md`](../api-inventory.md) §2, [`../architecture.md`](../architecture.md) §3.2
- [`../../frontend/README.md`](../../frontend/README.md) §5, [`../../admin/README.md`](../../admin/README.md) §4
- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0026](../../../docs/mvp/adr/0026-system-users-per-trust-zone.md), [`deploy/caddy/Caddyfile`](../../../deploy/caddy/Caddyfile)
- Caddy `reverse_proxy` header defaults: <https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults>
