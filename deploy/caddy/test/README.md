# Caddyfile smoke test

[`caddy-smoke.sh`](caddy-smoke.sh) runs the real [`deploy/caddy/Caddyfile`](../Caddyfile) under Caddy 2.8.4 on the loopback interface, with [`echo-upstream.mjs`](echo-upstream.mjs) in place of the apps, and checks with `curl` what a browser, an SDK user and an attacker would see. Task [X-022](../../../docs/mvp/plans/foundation-tasks.md) created it. CI runs it in the `deploy-files` job of [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml), so every Caddyfile change is tested end to end before it reaches the VM.

Read first: [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md) (storefront, edge headers, `ask`), [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §6 (Caddy and TLS), [ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) rows 1.4 and 4 (admin socket, TLS and HSTS).

## Run it

It needs no root and no network beyond `127.0.0.1`: Caddy 2.8.4, Node 22, `curl`, `openssl` and `awk`. The app ports 3000, 3001, 3002, 3100 and 4000 (echo upstream), 8080 and 8443 (Caddy) must be free, and nothing may listen on 2019. A run takes about 10 seconds.

```bash
# Caddy 2.8.4, checked against the SHA-512 that ci.yml pins
curl -fsSL -o /tmp/caddy.tgz https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz
echo "b8bec15d14fb033562af9f207850027bcbaa1f891edc9efe00d38bf39e1bf9944f8b6b8eba041ddd4c171cd70c905174c704d705be2f23bc678fe1eaf37a2485  /tmp/caddy.tgz" | sha512sum -c -
tar -xzf /tmp/caddy.tgz -C /tmp caddy

CADDY=/tmp/caddy bash deploy/caddy/test/caddy-smoke.sh   # or put caddy on PATH: bash deploy/caddy/test/caddy-smoke.sh
```

It prints one `PASS` or `FAIL` line per check and ends with `caddy-smoke: all checks passed` (exit 0) or `caddy-smoke: FAILED` (exit 1). Check names end with the acceptance criterion they prove (`[X-022 AC1]`). On a failure it prints the last lines of Caddy's and the echo upstream's logs.

| Setting | Default | Meaning |
|---|---|---|
| `CADDY` | `caddy` on `PATH` | The Caddy binary. Anything but v2.8.4 is refused. |
| `SMOKE_NODE` | `node` on `PATH` | Node for the echo upstream and for reading JSON |
| `SMOKE_TMPDIR` | `TMPDIR`, else `/tmp` | Parent of the temporary folder. The admin socket lives in it, and a unix socket path must stay under 100 bytes. |
| `SMOKE_KEEP=1` | off | Keep the temporary folder: the test copy, `caddy.log`, `echo.log`, Caddy's data folder with its local CA |

## How it works

1. **Production file.** `caddy validate` and `caddy fmt --diff` must be clean. `caddy adapt` with an empty environment must show only the placeholder hosts of [`decisions.md`](../../../docs/mvp/decisions.md) §4, the admin address `unix//run/caddy/admin.sock` and the file roots `/srv/velexis/maintenance` and `/srv/velexis/current/storefront` (so `VELEXIS_ROOT` has no default).
2. **Test copy.** Only the global options block changes: the admin socket moves to `<tmp>/admin.sock`, and `local_certs`, `skip_install_trust`, `default_bind 127.0.0.1`, `http_port 8080` and `https_port 8443` are added. The rest of the block stays, including the production `ask` URL `http://127.0.0.1:3100/internal/tls/ask`, which reaches the echo upstream. Every snippet and site block is the production text byte for byte; the script checks that.
3. **Environment.** Caddy runs with `env -i` and only `PLATFORM_BASE_DOMAIN=platform.localhost`, `STOREFRONT_BASE_DOMAIN=ota.localhost`, a random `VELEXIS_EDGE_SECRET`, `VELEXIS_ROOT=<tmp>/root`, and `HOME` and the XDG folders inside the temporary folder (its local CA and certificates land there; nothing is installed in the system trust store). `VELEXIS_ROOT` is a prefix the Caddyfile puts in front of `/srv/velexis/…`; it is never set on the VM, where it expands to nothing. Under it the script builds a storefront release (`releases/smoke/storefront` with `index.html`, `404.html`, `checkout/complete.html` and `assets/a.js`, and the symlink `current`) and copies [`maintenance/index.html`](../maintenance/index.html).
4. **Echo upstream.** `echo-upstream.mjs` listens on every app port the Caddyfile proxies to (3000, 3001, 3002, 3100 and 4000) and answers every request with a JSON echo of its port, method, URL and headers (each header as the list of values it received); `GET /redirect` answers 302 with `Location: /landing?<its own query>` and the same echo. On 3100 it is also the `ask` endpoint: 200 for `acme.ota.localhost`, 404 for anything else, and one `ask <host> <status>` line in its log. It never prints header values.
5. **Requests.** `curl --resolve <host>:8443:127.0.0.1 --cacert <Caddy's local root CA> --noproxy '*'`, so no DNS and no proxy are involved.

## What it checks

| Area | Checks |
|---|---|
| Production file (AC2, AC3) | `caddy validate`; `caddy fmt --diff` clean; placeholder hosts only; admin API on `unix//run/caddy/admin.sock`; file roots under `/srv/velexis` with no `VELEXIS_ROOT` default |
| Storefront `acme.ota.localhost` (AC1) | `/api/x` reaches 4000 as `/x` with `X-Velexis-Edge` = the secret and `X-Velexis-Host: acme.ota.localhost`, each exactly once, even when the client sends forged values. `/api/internal/*` and `/api/health/*` (except `/api/health/live`) answer 404 and never reach 4000, also when sent (`--path-as-is`) with a double slash, in upper case, with an encoded slash or with a dot segment. `/` serves `index.html` with `no-cache`; `/assets/a.js` is `public, max-age=31536000, immutable`; both carry the CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`). An unknown path serves `404.html` with the CSP and HSTS and without a `Server` header. |
| API hosts `api.ota.localhost` (4000), `api.platform.localhost` (3100) (AC1) | `/internal/x`, `/internal/tls/ask` and `/health/ready` answer 404 and never reach the upstream, and so do the same four variants; `/health/live` does; client copies of `X-Velexis-Edge` and `X-Velexis-Host` are removed |
| Next.js hosts `platform.localhost` (3000), `admin.platform.localhost` (3001), `admin.ota.localhost` (3002) | Each reaches its app with HSTS, `X-Frame-Options: DENY` and no `Server` header |
| On-demand TLS (AC1) | `evil.localhost` and `other.ota.localhost`: Caddy asks the `ask` endpoint, gets 404, stores no certificate, and the TLS handshake fails (curl exit 35). `acme.ota.localhost` gets its certificate after a 200. |
| Upstream stopped (AC1) | `platform.localhost` and both admin hosts answer 503 with the maintenance page byte for byte, `no-store`, `Retry-After: 30`, HSTS and no `Server` header. `api.platform.localhost`, `api.ota.localhost` and the storefront `/api` answer 503 with the JSON `SERVICE_UNAVAILABLE` envelope (`application/json`, `no-store`, HSTS, no `Server` header); `error.requestId` is the client's `X-Request-Id`, or a fresh UUID. Static storefront files are still served. |
| Admin API (AC1) | The unix socket answers `GET /config/` with the running configuration (with `Host: 127.0.0.1`; on a unix socket Caddy answers any other host name with 403); nothing listens on TCP 2019 and `http://127.0.0.1:2019/` is unreachable; Caddy's only TCP listeners are 8080 and 8443. `caddy reload --config <test copy>` succeeds after `X-Frame-Options` changes from `DENY` to `SAMEORIGIN`, and the new value is served. |
| ADR-0027 row 4 | TLS 1.2 and 1.3 are accepted and TLS 1.1 is refused with a protocol-version alert; HSTS on every host, error responses included. `http://` on an unknown host redirects to `https://` with 308. |
| Logs | Neither the edge secret nor a client's forged `X-Velexis-Edge` appears in Caddy's log (the access-log filter deletes the header). |
| Access log of a URL (FIX-W29-SECURITY) | On all six hosts, a request whose query carries a marker value for every parameter of the Caddyfile's `(log_query_filter)` (`sig`, `token`, Stripe's `client_secret`, `payment_intent_client_secret` and `setup_intent_client_secret`, and the personal data of the portal and admin URLs: `q`, `email`, `customerEmail`, `travelerLastName`, `targetId`, `next`), with the same query in its `Referer` and a page query in `Next-Router-State-Tree`, still succeeds: the storefront serves `/checkout/complete.html` (Stripe's 3-D Secure return) with 200, `/hello` reaches its app with every value, and the echo upstream's `/redirect` answers 302 with every value in its `Location`. No access log line holds any of the markers, in the URI, the `Referer` or the `Location`, nor the router state; each line keeps the other values (`keep`, and on the storefront Stripe's `payment_intent` and `redirect_status`). |

## What it found (fixed in X-022)

- **Storefront internal paths reached the OTA API.** `respond @api_internal 404` sorts after `handle` in Caddy's directive order, so `/api/internal/*` and `/api/health/ready` on a storefront host were proxied to the OTA API, with the edge secret. The storefront now has a `handle @api_private { respond 404 }` before `handle /api/*`, and blocks `/api/health/*` except `/api/health/live`, as the API hosts do ([ADR-0016](../../../docs/mvp/adr/0016-observability.md)).
- **Error responses lost their security headers.** A `header` block that deletes a header (`-Server`) is deferred, and Caddy does not apply deferred headers to responses written by `handle_errors`. The maintenance page, the JSON envelope and the storefront 404 page had no HSTS, no CSP and a `Server: Caddy` header. Each `handle_errors` block now imports its header snippet (`security_headers`, or the new `storefront_headers`).
- **Hard-coded `/srv/velexis` paths** made the file untestable without root. They now start with `{$VELEXIS_ROOT}`, which is empty on the VM.

## Extending it

Tasks that change the Caddyfile add their assertions here (for example OFE-014 for the airline-card page headers, OFE-020 for `/p/*`, OBE-084 for `X-Forwarded-For`, X-039 for the WAF). A page that puts a new secret or personal value into its URL adds the parameter to `(log_query_filter)` and to `LOG_PARAMS` of step 6b, which then proves its absence from the access log on every host. Keep the rules: only the global options block of the test copy differs from the production file, every request goes through `fetch` (no proxy, local CA), failure output never prints the edge secret (`redact`), and each new check names the criterion it proves. Run `shellcheck -S style deploy/caddy/test/caddy-smoke.sh` and `pnpm format:check` (it covers `echo-upstream.mjs`).
