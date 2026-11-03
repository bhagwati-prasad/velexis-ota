// The TLS probe of storefront hosts (PBE-051; platform/docs/flows/custom-domains.md steps 3 and 4, PADR-0004 item 7,
// ADR-0018 lifecycle step 4, scope PF-41 AC3). Caddy obtains and renews the certificates of the storefront hosts itself
// (on-demand TLS behind the `ask` endpoint); the probe only reports what Caddy serves, so the portal and the platform
// admin show `tls_status` and the expiry, and the OTA backend uses a custom domain in links only once its certificate
// is issued (lead decision (2e) of 2026-11-02).
//
// - **probeTls** opens a TLS connection to the probe target (TLS_PROBE_TARGET: Caddy on `127.0.0.1:443` in
//   production; tests inject a local TLS server on a free port) with the host as SNI and reads the peer certificate:
//   - `issued`: the handshake succeeded and the certificate names the host (`X509Certificate.checkHost`, wildcards
//     included) and has not reached its `valid_to` at the Clock's now;
//   - `expired`: the same certificate, past its `valid_to`;
//   - `failed`: no connection, a handshake error (Caddy refuses the handshake while it has no certificate for the
//     host: `ask` refused it, or issuance failed), no answer within TLS_PROBE_TIMEOUT_MS, no certificate, or a
//     certificate for another name.
//   The chain is not verified against a CA: the probe reports the certificate Caddy serves, whoever issued it (Let's
//   Encrypt's staging CA in the M5 exit test included). The first probe after a verification is what makes Caddy ask
//   the `ask` endpoint and obtain the certificate, so the first traveller does not wait for it; issuance holds the
//   handshake for a few seconds, hence the 30-second bound.
// - **DomainTlsProbe** (worker) is one `domain.tls_probe {domainId}` job of `platform-domains`: the domain is read (one
//   that is gone is left alone, `domains.tls_probe_skipped`), probed outside any transaction, then in one transaction
//   with the row locked: `tls_status`, `tls_expires_at` (the certificate's `valid_to`; `null` when the probe failed and
//   no certificate was read) and `tls_checked_at` are stored. Whenever `tls_status` changes, the `domain` invalidation
//   of the host follows the commit (lead decision (2d) of 2026-11-02): the OTA backend's link rule reads it. A probe
//   with an unchanged status publishes nothing. Who is probed is the callers' choice: the verification one minute
//   after a domain is verified (domain-checks.processor.ts), the daily run of every served host
//   (recheck.scheduler.ts) and the platform admin's re-check (admin-domains.service.ts). The probe never fails the job:
//   a failed handshake is the `failed` outcome, which the next probe asks again; a database failure fails the job and
//   BullMQ tries again (ADR-0009).
//
// Nothing here logs a certificate: the lines carry the domain id, the tenant, the status and the failure code.
import { Inject, Injectable, type ValueProvider } from "@nestjs/common";
import type { X509Certificate } from "node:crypto";
import { connect } from "node:tls";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { DomainsRepository } from "./domains.repository";

/** Where the probe connects: the TLS listener that serves the storefront hosts. */
export interface TlsProbeTarget {
  /** An IP address (Caddy listens on the VM's loopback interface too). */
  readonly host: string;
  readonly port: number;
}

/** The injection token of the worker's TlsProbeTarget. */
export const TLS_PROBE_TARGET = Symbol("TLS_PROBE_TARGET");

/** Caddy's HTTPS listener on the VM (PADR-0004 item 7: `127.0.0.1:443`). */
export const DEFAULT_TLS_PROBE_TARGET: TlsProbeTarget = Object.freeze({ host: "127.0.0.1", port: 443 });

/** The provider of TLS_PROBE_TARGET: Caddy on the loopback interface. Tests override it with a local TLS server. */
export const tlsProbeTargetProvider: ValueProvider<TlsProbeTarget> = {
  provide: TLS_PROBE_TARGET,
  useValue: DEFAULT_TLS_PROBE_TARGET,
};

/**
 * How long a probe may take, connection and handshake together: the first handshake of a newly verified host waits
 * while Caddy obtains its certificate.
 */
export const TLS_PROBE_TIMEOUT_MS = 30_000;

/** The `tls_status` values a probe stores (`pending` is the value before the first probe). */
export type ProbedTlsStatus = "issued" | "expired" | "failed";

/** Why a probe failed (logged and kept with the job; never shown as a certificate detail). */
export type TlsProbeFailure =
  "connect_failed" | "handshake_failed" | "timeout" | "no_certificate" | "name_mismatch" | "bad_expiry";

/** What one probe found. */
export type TlsProbeOutcome =
  | { readonly status: "issued" | "expired"; readonly expiresAt: Date }
  | { readonly status: "failed"; readonly failure: TlsProbeFailure };

/** The probe's options; tests shorten the timeout. */
export interface TlsProbeOptions {
  readonly timeoutMs?: number;
}

/** True when `code` is a socket error of the TCP connection itself (nothing listened, no route), not of TLS. */
function isConnectError(code: unknown): boolean {
  return (
    code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL"
  );
}

/** The outcome of a peer certificate read at `now` for `hostname`. */
export function outcomeOfCertificate(
  certificate: X509Certificate | undefined,
  hostname: string,
  now: Date,
): TlsProbeOutcome {
  if (certificate === undefined) {
    return { status: "failed", failure: "no_certificate" };
  }
  if (certificate.checkHost(hostname) === undefined) {
    return { status: "failed", failure: "name_mismatch" };
  }
  const expiresAt = new Date(certificate.validTo);
  if (Number.isNaN(expiresAt.getTime())) {
    return { status: "failed", failure: "bad_expiry" };
  }
  return { status: now.getTime() >= expiresAt.getTime() ? "expired" : "issued", expiresAt };
}

/**
 * Connects to `target` with `hostname` as SNI and reads the peer certificate (see the file header). `now` is the
 * instant the expiry is compared with (the Clock's). Never rejects: every failure is a `failed` outcome.
 */
export function probeTls(
  hostname: string,
  target: TlsProbeTarget,
  now: () => Date,
  options: TlsProbeOptions = {},
): Promise<TlsProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? TLS_PROBE_TIMEOUT_MS;
  return new Promise<TlsProbeOutcome>((resolveProbe) => {
    let settled = false;
    let connected = false;
    const socket = connect({
      host: target.host,
      port: target.port,
      servername: hostname,
      // The probe reports the certificate Caddy serves; it does not judge the issuer (file header).
      rejectUnauthorized: false,
    });
    const finish = (outcome: TlsProbeOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(outcome);
    };
    const timer = setTimeout(() => finish({ status: "failed", failure: "timeout" }), timeoutMs);
    socket.once("connect", () => {
      connected = true;
    });
    socket.once("secureConnect", () => {
      finish(outcomeOfCertificate(socket.getPeerX509Certificate(), hostname, now()));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        status: "failed",
        failure: !connected && isConnectError(error.code) ? "connect_failed" : "handshake_failed",
      });
    });
    // A peer that closes the connection before the handshake ends gives no error event on every Node version.
    socket.once("close", () => finish({ status: "failed", failure: "handshake_failed" }));
  });
}

/** What a finished `domain.tls_probe` job returns (BullMQ keeps it): the id, the status and why it failed. */
export interface DomainTlsProbeResult {
  readonly domainId: string;
  /** The stored `tls_status`; `missing` when the domain was gone (nothing written). */
  readonly status: ProbedTlsStatus | "missing";
  /** False when the job left the domain alone. */
  readonly probed: boolean;
  /** True when the stored `tls_status` changed (the `domain` invalidation followed the commit). */
  readonly changed?: boolean;
  /** Why the probe failed. */
  readonly failure?: TlsProbeFailure;
}

@Injectable()
export class DomainTlsProbe {
  constructor(
    private readonly domains: DomainsRepository,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(TLS_PROBE_TARGET) private readonly target: TlsProbeTarget,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(DomainTlsProbe.name) private readonly logger: PinoLogger,
  ) {}

  /** One `domain.tls_probe` job (see the file header). */
  async probe(domainId: string): Promise<DomainTlsProbeResult> {
    const row = await this.domains.findForCheck(domainId);
    if (row === undefined) {
      this.logger.info({ domainId }, "domains.tls_probe_skipped");
      return { domainId, status: "missing", probed: false };
    }
    const outcome = await probeTls(row.hostname, this.target, () => this.clock.now());

    const stored = await runInTransaction(this.db, async (trx) => {
      const current = await this.domains.lockForCheck(trx, domainId);
      if (current === undefined) {
        return undefined;
      }
      const now = this.clock.now();
      await this.domains.recordTlsProbe(trx, domainId, {
        status: outcome.status,
        expiresAt: outcome.status === "failed" ? null : outcome.expiresAt,
        now,
      });
      const changed = current.tls_status !== outcome.status;
      if (changed) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: current.hostname });
      }
      return { changed, previous: current.tls_status };
    });
    if (stored === undefined) {
      this.logger.info({ domainId, tenantId: row.tenant_id }, "domains.tls_probe_skipped");
      return { domainId, status: "missing", probed: false };
    }
    this.logger.info(
      {
        domainId,
        tenantId: row.tenant_id,
        tlsStatus: outcome.status,
        previousTlsStatus: stored.previous,
        ...(outcome.status === "failed" ? { failure: outcome.failure } : {}),
      },
      "domains.tls_probed",
    );
    return {
      domainId,
      status: outcome.status,
      probed: true,
      changed: stored.changed,
      ...(outcome.status === "failed" ? { failure: outcome.failure } : {}),
    };
  }
}
