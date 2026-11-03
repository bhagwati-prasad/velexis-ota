// Local TLS servers for the tests of the TLS probe (PBE-051; src/domains/tls-probe.ts): the probe connects to Caddy on
// `127.0.0.1:443` in production, and the tests point it (TLS_PROBE_TARGET) at a server of this file on a free loopback
// port instead.
//
// - `startTlsServer(hostnames)`: a `node:tls` server whose certificate names `hostnames` (subject alternative names),
//   self-signed, valid from now for one day. Its EC P-256 key is generated on the spot by `node:crypto`, and the
//   certificate is made by the `openssl` command (`openssl req -x509`, OpenSSL 3 or LibreSSL 3, which CI's runners
//   and the development machines have; ci.yml already calls it), in a temporary folder of mode 0700 that is deleted
//   at once. Nothing is a secret: the key never leaves this process and the folder. It answers every SNI with the
//   same certificate, so a host it does not name gets a certificate for another name, and it keeps the SNI names the
//   clients sent (`servernames`, read in the server's SNI callback while it handles the ClientHello, so before the
//   client's handshake can end), which proves that the probe sends the host as SNI. A client without SNI adds none.
// - `startRefusingServer()`: a TCP server that closes every connection at once, before any TLS: a handshake error.
// - `localCertificateAuthority()` and `startTlsServer(hostnames, {issuer})` (FIX-W40-PLATFORM, lead decision (2e) of
//   2026-11-03): a certificate authority of the test (a CA certificate and key made the same way, valid for one day),
//   and a server whose certificate it signed (`openssl req -new` and `openssl x509 -req -CA …`, which OpenSSL 3 and
//   LibreSSL 3 both have), so the probe's production mode can be shown to accept a chain that verifies against the CA
//   given as its trust anchor, and to refuse the same chain against Node.js's default trust store.
//
// Spawning `openssl` takes tens of milliseconds: tests call these in their `beforeAll` hooks.
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer } from "node:tls";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A server of this file on `127.0.0.1`. */
export interface LocalServer {
  readonly host: "127.0.0.1";
  readonly port: number;
  close(): Promise<void>;
}

/** A TLS server with its certificate. */
export interface LocalTlsServer extends LocalServer {
  /** The certificate the server presents, as PEM. */
  readonly certificatePem: string;
  /** Its `valid_to`, as the probe reads it. */
  readonly expiresAt: Date;
  /** The SNI names the clients sent, in the order the handshakes began (see the file header). */
  readonly servernames: readonly string[];
}

/** A certificate and its private key, as PEM. */
export interface CertificateAndKey {
  readonly certificatePem: string;
  readonly keyPem: string;
}

/** A new EC P-256 private key, as PKCS #8 PEM. */
function newPrivateKey(): string {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

/** Runs `work` in a new temporary folder of mode 0700, deleted afterwards. */
async function inTemporaryFolder<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "velexis-platform-tls-"));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A self-signed certificate for `hostnames`, valid for one day from now, and its private key, as PEM. */
export async function selfSignedCertificate(hostnames: readonly string[]): Promise<CertificateAndKey> {
  const [first] = hostnames;
  if (first === undefined) {
    throw new TypeError("selfSignedCertificate: name at least one host");
  }
  const privateKey = newPrivateKey();
  return inTemporaryFolder(async (dir) => {
    const keyPath = join(dir, "key.pem");
    const certificatePath = join(dir, "certificate.pem");
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-new",
      "-key",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      `/CN=${first}`,
      "-addext",
      `subjectAltName=${hostnames.map((name) => `DNS:${name}`).join(",")}`,
    ]);
    return { certificatePem: readFileSync(certificatePath, "utf8"), keyPem: privateKey };
  });
}

/** A certificate authority of the test: a self-signed CA certificate (`CA:TRUE`), valid for one day, and its key. */
export async function localCertificateAuthority(): Promise<CertificateAndKey> {
  const privateKey = newPrivateKey();
  return inTemporaryFolder(async (dir) => {
    const keyPath = join(dir, "ca-key.pem");
    const certificatePath = join(dir, "ca.pem");
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-new",
      "-key",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=Velexis platform test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    return { certificatePem: readFileSync(certificatePath, "utf8"), keyPem: privateKey };
  });
}

/** A certificate for `hostnames` that `issuer` signed, valid for one day from now, and its private key, as PEM. */
export async function issuedCertificate(
  hostnames: readonly string[],
  issuer: CertificateAndKey,
): Promise<CertificateAndKey> {
  const [first] = hostnames;
  if (first === undefined) {
    throw new TypeError("issuedCertificate: name at least one host");
  }
  const privateKey = newPrivateKey();
  return inTemporaryFolder(async (dir) => {
    const keyPath = join(dir, "key.pem");
    const requestPath = join(dir, "request.csr");
    const issuerPath = join(dir, "ca.pem");
    const issuerKeyPath = join(dir, "ca-key.pem");
    const extensionsPath = join(dir, "extensions.cnf");
    const certificatePath = join(dir, "certificate.pem");
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    writeFileSync(issuerPath, issuer.certificatePem);
    writeFileSync(issuerKeyPath, issuer.keyPem, { mode: 0o600 });
    writeFileSync(
      extensionsPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=${hostnames.map((name) => `DNS:${name}`).join(",")}`,
        "",
      ].join("\n"),
    );
    await execFileAsync("openssl", [
      "req",
      "-new",
      "-key",
      keyPath,
      "-out",
      requestPath,
      "-subj",
      `/CN=${first}`,
    ]);
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      requestPath,
      "-CA",
      issuerPath,
      "-CAkey",
      issuerKeyPath,
      "-set_serial",
      `0x${randomBytes(8).toString("hex")}`,
      "-days",
      "1",
      "-extfile",
      extensionsPath,
      "-out",
      certificatePath,
    ]);
    return { certificatePem: readFileSync(certificatePath, "utf8"), keyPem: privateKey };
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  return (server.address() as AddressInfo).port;
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
}

/**
 * A TLS server on a free loopback port whose certificate names `hostnames` (see the file header): self-signed, or
 * signed by `options.issuer`.
 */
export async function startTlsServer(
  hostnames: readonly string[],
  options: { readonly issuer?: CertificateAndKey } = {},
): Promise<LocalTlsServer> {
  const { certificatePem, keyPem } =
    options.issuer === undefined
      ? await selfSignedCertificate(hostnames)
      : await issuedCertificate(hostnames, options.issuer);
  const context = createSecureContext({ cert: certificatePem, key: keyPem });
  const servernames: string[] = [];
  const server = createTlsServer(
    {
      cert: certificatePem,
      key: keyPem,
      // Called only for a ClientHello with SNI: keeps the name and answers with the one certificate.
      SNICallback: (servername, answer) => {
        servernames.push(servername);
        answer(null, context);
      },
    },
    (socket) => {
      socket.on("error", () => undefined);
      socket.end();
    },
  );
  server.on("tlsClientError", () => undefined);
  const port = await listen(server);
  return {
    host: "127.0.0.1",
    port,
    certificatePem,
    expiresAt: new Date(new X509Certificate(certificatePem).validTo),
    servernames,
    close: closer(server),
  };
}

/** A TCP server on a free loopback port that closes every connection before any TLS: a handshake error. */
export async function startRefusingServer(): Promise<LocalServer> {
  const server = createTcpServer((socket) => {
    socket.on("error", () => undefined);
    socket.destroy();
  });
  const port = await listen(server);
  return { host: "127.0.0.1", port, close: closer(server) };
}
