// The TLS probe of a storefront host (PBE-051; flows/custom-domains.md step 4, PADR-0004 item 7, scope PF-41 AC3)
// against local servers on free loopback ports (test/support/tls-server.ts): a TLS server with a self-signed
// certificate for the probed names, a TCP server that closes every connection before TLS, a server that never answers,
// and a port where nothing listens. The probe reads the certificate's names and expiry, never its issuer, and never
// rejects. The store, the invalidation and the job are proven in test/integration/domains/domain-recheck.int.test.ts.
import { X509Certificate } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startRefusingServer,
  startTlsServer,
  type LocalServer,
  type LocalTlsServer,
} from "../../test/support/tls-server";
import { outcomeOfCertificate, probeTls, TLS_PROBE_TIMEOUT_MS, type TlsProbeTarget } from "./tls-probe";

const HOST = "travel.example.net";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A probe of a server that never answers ends after this: short, so the test stays well under Vitest's 5 s. */
const SHORT_TIMEOUT_MS = 300;

let tls: LocalTlsServer;
let wildcard: LocalTlsServer;
let refusing: LocalServer;
let silent: Server;
const silentSockets = new Set<Socket>();
/** A loopback port where nothing listens: bound to port 0, then released. */
let closedPort = 0;

beforeAll(async () => {
  // Spawning `openssl` for the two certificates and starting four servers: a few hundred milliseconds, once per file
  // (budget 20 s for a loaded CI runner).
  tls = await startTlsServer([HOST, "www.example.net"]);
  wildcard = await startTlsServer(["*.ota.example.com"]);
  refusing = await startRefusingServer();
  silent = createServer((socket) => {
    silentSockets.add(socket);
    // Reads (and drops) what the client sends, so the client's close is seen; never answers.
    socket.resume();
    socket.on("error", () => undefined);
    socket.on("close", () => silentSockets.delete(socket));
  });
  await new Promise<void>((resolveListen) => silent.listen(0, "127.0.0.1", () => resolveListen()));
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", () => resolveListen()));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
}, 20_000);

afterAll(async () => {
  for (const socket of silentSockets) {
    socket.destroy();
  }
  await Promise.all([
    tls?.close(),
    wildcard?.close(),
    refusing?.close(),
    new Promise<void>((resolveClose) =>
      silent === undefined ? resolveClose() : silent.close(() => resolveClose()),
    ),
  ]);
});

const targetOf = (server: LocalServer): TlsProbeTarget => ({ host: server.host, port: server.port });

describe("probeTls", () => {
  it("[PBE-051 AC1] reads the certificate a local TLS server presents for the host: issued, with its expiry", async () => {
    const now = new Date();

    const outcome = await probeTls(HOST, targetOf(tls), () => now);

    expect(outcome).toEqual({ status: "issued", expiresAt: tls.expiresAt });
    // The expiry is the certificate's own `valid_to` (one day after it was made), not a time of the probe.
    expect(tls.expiresAt.getTime()).toBe(new Date(new X509Certificate(tls.certificatePem).validTo).getTime());
  });

  it("[PBE-051 AC1] sends the host as SNI: every name of the certificate is issued, a wildcard included", async () => {
    const now = new Date();
    const sentBefore = tls.servernames.length;
    const wildcardSentBefore = wildcard.servernames.length;

    expect(await probeTls("www.example.net", targetOf(tls), () => now)).toMatchObject({ status: "issued" });
    expect(await probeTls("acme.ota.example.com", targetOf(wildcard), () => now)).toEqual({
      status: "issued",
      expiresAt: wildcard.expiresAt,
    });
    // The servers saw the probed host in the ClientHello: the probe connects to an IP address, so only SNI names it.
    expect(tls.servernames.slice(sentBefore)).toEqual(["www.example.net"]);
    expect(wildcard.servernames.slice(wildcardSentBefore)).toEqual(["acme.ota.example.com"]);
  });

  it("[PBE-051 AC1] a certificate past its valid_to at the Clock's now is expired, with its expiry", async () => {
    const later = new Date(tls.expiresAt.getTime() + DAY_MS);

    expect(await probeTls(HOST, targetOf(tls), () => later)).toEqual({
      status: "expired",
      expiresAt: tls.expiresAt,
    });
    // The very instant of `valid_to` is past it.
    expect(await probeTls(HOST, targetOf(tls), () => tls.expiresAt)).toMatchObject({ status: "expired" });
  });

  it("[PBE-051 AC1] a certificate for another name is no certificate of the host: failed", async () => {
    const now = new Date();

    expect(await probeTls("shop.example.org", targetOf(tls), () => now)).toEqual({
      status: "failed",
      failure: "name_mismatch",
    });
    // A wildcard covers one label only.
    expect(await probeTls("a.b.ota.example.com", targetOf(wildcard), () => now)).toEqual({
      status: "failed",
      failure: "name_mismatch",
    });
  });

  it("[PBE-051 AC1] a handshake error is failed: a server that closes the connection before TLS", async () => {
    expect(await probeTls(HOST, targetOf(refusing), () => new Date())).toEqual({
      status: "failed",
      failure: "handshake_failed",
    });
  });

  it("[PBE-051 AC1] no listener is failed: the connection is refused", async () => {
    expect(await probeTls(HOST, { host: "127.0.0.1", port: closedPort }, () => new Date())).toEqual({
      status: "failed",
      failure: "connect_failed",
    });
  });

  it("[PBE-051 AC1] a server that never answers is failed once the timeout ends, and the connection is closed", async () => {
    const target = { host: "127.0.0.1", port: (silent.address() as AddressInfo).port };

    const outcome = await probeTls(HOST, target, () => new Date(), { timeoutMs: SHORT_TIMEOUT_MS });

    expect(outcome).toEqual({ status: "failed", failure: "timeout" });
    // The probe destroyed its socket: the server sees the connection close.
    await vi.waitFor(() => expect(silentSockets.size).toBe(0), { timeout: 2_000, interval: 10 });
    expect(TLS_PROBE_TIMEOUT_MS).toBe(30_000);
  });
});

describe("outcomeOfCertificate", () => {
  it("[PBE-051 AC1] a handshake without a peer certificate is failed", () => {
    expect(outcomeOfCertificate(undefined, HOST, new Date())).toEqual({
      status: "failed",
      failure: "no_certificate",
    });
  });

  it("[PBE-051 AC1] compares the expiry with the instant it is given", () => {
    const certificate = new X509Certificate(tls.certificatePem);
    const before = new Date(tls.expiresAt.getTime() - 1);

    expect(outcomeOfCertificate(certificate, HOST, before)).toEqual({
      status: "issued",
      expiresAt: tls.expiresAt,
    });
    expect(outcomeOfCertificate(certificate, HOST, tls.expiresAt)).toEqual({
      status: "expired",
      expiresAt: tls.expiresAt,
    });
  });
});
