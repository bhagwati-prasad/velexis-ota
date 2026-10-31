// The host name rules of a custom storefront domain (PBE-049; PADR-0004 item 1, flows/custom-domains.md step 1,
// api-inventory-resources.md §2 `addDomain`, scope PF-41 AC1). Pure: no Nest, no database. `addDomain` passes the
// owner's input through `customHostnameOrThrow`, which answers the host name to store or throws `422 DOMAIN_INVALID`
// (the error carries no details: the portal shows the one message of the catalogue).
//
// Normalisation, in this order:
// 1. surrounding white space is dropped (a pasted name often carries some);
// 2. an IP address, also in brackets (`[2001:db8::1]`), is refused at once;
// 3. ASCII characters other than letters, digits, `-` and `.` are refused before the IDN conversion, because the URL
//    host parser behind `domainToASCII` stops at `/`, `\`, `?` or `#` and would keep only what comes before them
//    (`travel.acme.com/x` would become `travel.acme.com`);
// 4. `domainToASCII` of `node:url` lower-cases the name and turns IDN labels into punycode (UTS #46 mapping, so
//    `Bücher.example.net` is stored as `xn--bcher-kva.example.net`); a name it cannot convert is refused;
// 5. one trailing dot is dropped (`Travel.Acme.com.` is stored as `travel.acme.com`).
//
// The result must then:
// - not be an IP address (the IPv4 parser of `domainToASCII` also reads `0x7f.1` or `1.2.3.4.` as one);
// - have at most 253 characters and valid labels: 1–63 characters of `a-z`, `0-9` and inner `-`, at least two labels,
//   the last one starting with a letter, which is HOSTNAME_PATTERN, the rule of TLS `ask` (TLS_ASK_HOST_PATTERN), of
//   the `tlsask:` key builder and of the `domain` invalidation event, so every host `addDomain` stores can be asked
//   for and announced;
// - not be a Velexis host or a host below one (`velexisHostsOf`): STOREFRONT_BASE_DOMAIN, the hosts of the public URLs
//   of the platform, and the placeholder hosts of docs/mvp/decisions.md §4;
// - not be a shared hosting suffix of SHARED_SUFFIX_DENY_LIST or a host below one, where owning a sub-domain proves
//   nothing about the zone.
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { AppError } from "@velexis/errors";
import type { PlatformBackendConfig } from "../config";

/** The longest host name (RFC 1035, PADR-0004 item 1), without the trailing dot. */
export const MAX_HOSTNAME_LENGTH = 253;

/**
 * A stored host name: lower-case labels of 1–63 characters of `a-z`, `0-9` and inner `-` (punycode `xn--` labels
 * included), at least two labels, no trailing dot, and a last label that starts with a letter, so no IPv4 address
 * passes (an IPv6 address has `:`). The same expression as TLS_ASK_HOST_PATTERN and the `hostname` field of the
 * `domain` invalidation event (hostname-rules.test.ts compares them).
 */
export const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The shared hosting suffixes a custom domain may neither be nor sit below (PADR-0004 item 1: "a deny list of shared
 * hosting suffixes kept in code"; flows/custom-domains.md step 1 names `github.io` and `herokuapp.com`, the
 * `addDomain` description of the OpenAPI document adds `vercel.app` and `netlify.app`). The entries come from the
 * PRIVATE section of the Public Suffix List (https://publicsuffix.org/list/public_suffix_list.dat): suffixes under
 * which a hosting service hands out sub-domains to its customers, so a customer's sub-domain proves nothing about who
 * owns the zone. Three are wider than a listed suffix: `amazonaws.com` and `railway.app` are the parent zones of the
 * list's many `….amazonaws.com` and `up.railway.app` entries, refused whole, and `glitch.me` is a hosting zone of the
 * same kind that the list does not name. A small, hand-picked list of the common ones, not the whole list; lower case,
 * sorted.
 */
export const SHARED_SUFFIX_DENY_LIST: readonly string[] = Object.freeze([
  "amazonaws.com",
  "amplifyapp.com",
  "appspot.com",
  "azurestaticapps.net",
  "azurewebsites.net",
  "bitbucket.io",
  "blogspot.com",
  "cloudapp.net",
  "cloudfront.net",
  "codeberg.page",
  "deno.dev",
  "elasticbeanstalk.com",
  "firebaseapp.com",
  "fly.dev",
  "github.io",
  "gitlab.io",
  "glitch.me",
  "herokuapp.com",
  "myshopify.com",
  "netlify.app",
  "ngrok-free.app",
  "ngrok.io",
  "now.sh",
  "onrender.com",
  "pages.dev",
  "railway.app",
  "readthedocs.io",
  "repl.co",
  "surge.sh",
  "trycloudflare.com",
  "vercel.app",
  "web.app",
  "webflow.io",
  "wixsite.com",
  "workers.dev",
]);

/**
 * The hosts of the table of docs/mvp/decisions.md §4 under their placeholder names: the portal, the platform admin,
 * the platform API, the storefront parent domain (`<key>.ota.example.com`), the OTA admin and the OTA API. Every
 * environment of this repository uses these names until a VM's configuration replaces them; the configured hosts are
 * added by `velexisHostsOf`.
 */
export const DECISIONS_PLACEHOLDER_HOSTS: readonly string[] = Object.freeze([
  "platform.example.com",
  "admin.platform.example.com",
  "api.platform.example.com",
  "ota.example.com",
  "admin.ota.example.com",
  "api.ota.example.com",
]);

/** The configuration values the Velexis hosts come from. */
export type VelexisHostConfig = Pick<
  PlatformBackendConfig,
  "STOREFRONT_BASE_DOMAIN" | "PUBLIC_PORTAL_URL" | "PUBLIC_PLATFORM_ADMIN_URL" | "PUBLIC_OTA_ADMIN_URL"
>;

/** What `checkCustomHostname` checks a host against. */
export interface HostnameRules {
  /** Hosts Velexis serves, lower case: each of them and every host below it are refused. */
  readonly velexisHosts: readonly string[];
}

/** Why a host name is refused (for tests and the code's own reasoning; the API answers DOMAIN_INVALID alone). */
export type HostnameProblem = "syntax" | "too_long" | "ip_address" | "velexis_host" | "shared_suffix";

/** The outcome of the rules: the host name to store, or the first rule it breaks. */
export type HostnameCheck =
  | { readonly ok: true; readonly hostname: string }
  | { readonly ok: false; readonly problem: HostnameProblem };

/**
 * The Velexis hosts of a configuration (decisions.md §4): STOREFRONT_BASE_DOMAIN, which covers every `<key>.` storefront
 * sub-domain, the OTA admin (`admin.ota.…`) and the OTA API (`api.ota.…`); the hosts of PUBLIC_PORTAL_URL (whose
 * sub-domains are the platform admin and the platform API, `admin.platform.…` and `api.platform.…`),
 * PUBLIC_PLATFORM_ADMIN_URL and PUBLIC_OTA_ADMIN_URL, in case a deployment moves one of them elsewhere; and the
 * placeholder hosts of DECISIONS_PLACEHOLDER_HOSTS. Lower case, each once.
 */
export function velexisHostsOf(config: VelexisHostConfig): string[] {
  const hosts = [
    config.STOREFRONT_BASE_DOMAIN,
    ...[config.PUBLIC_PORTAL_URL, config.PUBLIC_PLATFORM_ADMIN_URL, config.PUBLIC_OTA_ADMIN_URL].map(
      (url) => new URL(url).hostname,
    ),
    ...DECISIONS_PLACEHOLDER_HOSTS,
  ];
  return [...new Set(hosts.map((host) => host.toLowerCase()).filter((host) => host.length > 0))];
}

/** True when `host` is `zone` or a host below it (`a.b.zone`), on label boundaries. */
export function isAtOrBelow(host: string, zone: string): boolean {
  return host === zone || host.endsWith(`.${zone}`);
}

/** ASCII characters other than letters, digits, `-` and `.`; non-ASCII characters are left to the IDN mapping. */
const REFUSED_ASCII = /[^A-Za-z0-9.\-\u0080-\u{10ffff}]/u;

/** True when `value` is an IPv4 or IPv6 address, also an IPv6 address in brackets. */
function isIpAddress(value: string): boolean {
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(unbracketed) !== 0;
}

/**
 * The owner's input as it is stored, or the first rule it breaks (see the file header for the order). Pure and
 * synchronous; never logs.
 */
export function checkCustomHostname(input: string, rules: HostnameRules): HostnameCheck {
  const trimmed = input.trim();
  if (isIpAddress(trimmed)) {
    return { ok: false, problem: "ip_address" };
  }
  if (trimmed.length === 0 || REFUSED_ASCII.test(trimmed)) {
    return { ok: false, problem: "syntax" };
  }
  const ascii = domainToASCII(trimmed);
  if (ascii.length === 0) {
    return { ok: false, problem: "syntax" };
  }
  const hostname = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (isIpAddress(hostname)) {
    return { ok: false, problem: "ip_address" };
  }
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, problem: "too_long" };
  }
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return { ok: false, problem: "syntax" };
  }
  if (rules.velexisHosts.some((zone) => isAtOrBelow(hostname, zone))) {
    return { ok: false, problem: "velexis_host" };
  }
  if (SHARED_SUFFIX_DENY_LIST.some((suffix) => isAtOrBelow(hostname, suffix))) {
    return { ok: false, problem: "shared_suffix" };
  }
  return { ok: true, hostname };
}

/** The host name to store for the owner's input, or `422 DOMAIN_INVALID` (no details) when it breaks a rule. */
export function customHostnameOrThrow(input: string, rules: HostnameRules): string {
  const check = checkCustomHostname(input, rules);
  if (!check.ok) {
    throw new AppError("DOMAIN_INVALID");
  }
  return check.hostname;
}

// ---- The verification value (PADR-0004 item 2) ---------------------------------------------------------------------

/** Crockford's base32 (no I, L, O, U), as ULIDs and recovery codes use it. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The random characters of a verification value: 32 base32 characters of 5 bits each, 160 random bits. */
export const VERIFICATION_TOKEN_CHARACTERS = 32;

/** A verification value: `vx-verify-` and 32 Crockford base32 characters. */
export const VERIFICATION_TOKEN_PATTERN = /^vx-verify-[0-9A-HJKMNP-TV-Z]{32}$/;

/**
 * A new verification value for the `TXT _velexis.<host>` record (PADR-0004 item 2): `vx-verify-` and 32 Crockford
 * base32 characters of 160 fresh random bits. It is published in public DNS, so it is no secret; it only has to be
 * unguessable, so nobody can prepare the record of a host before its owner adds it.
 */
export function newVerificationToken(): string {
  const bytes = randomBytes((VERIFICATION_TOKEN_CHARACTERS * 5) / 8);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  let encoded = "";
  for (let index = 0; index < VERIFICATION_TOKEN_CHARACTERS; index += 1) {
    encoded = `${CROCKFORD[Number(value & 31n)] ?? "0"}${encoded}`;
    value >>= 5n;
  }
  return `vx-verify-${encoded}`;
}
