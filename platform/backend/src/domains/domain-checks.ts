// The DNS checks of a custom storefront domain (PBE-050; PADR-0004 items 2 and 3, flows/custom-domains.md step 2 and
// "Failure handling", scope PF-41 AC2). Pure: no Nest, no database, no clock and no network of its own. The caller
// hands in a `DnsResolver` (dns.gateway.ts in the worker: a `node:dns` `Resolver` on DNS_RESOLVERS; a fake in tests),
// the domain and what it must point to, and gets back whether both proofs hold or the one error code the portal shows.
//
// Two proofs, both required (PADR-0004 item 2):
// - **Ownership**: the TXT record set of `_velexis.<host>` contains the domain's verification value (one record, its
//   character strings joined, equal to the value once surrounding white space is dropped).
// - **Routing**: the CNAME chain of `<host>` reaches `<key>.<STOREFRONT_BASE_DOMAIN>` (at most MAX_CNAME_HOPS links),
//   or the host has A/AAAA records and every one of them is a storefront address (STOREFRONT_IPV4, STOREFRONT_IPV6),
//   for a zone apex, which cannot have a CNAME. The addresses are asked only when the chain does not reach the target.
//
// The error codes (`tenant_domains.last_check_error`, the portal's DNS_CHECK_ERRORS), one per check, the ownership
// proof first:
// - `txt_missing`: no TXT record at `_velexis.<host>` (NXDOMAIN, or the name has no TXT record);
// - `txt_mismatch`: TXT records exist there, none holds the value;
// - `cname_missing`: the host has neither a CNAME nor A/AAAA records;
// - `cname_wrong_target`: the host has a CNAME, its chain ends elsewhere, and its addresses are not all storefront
//   addresses;
// - `a_wrong_address`: the host has no CNAME and an A or AAAA record outside the storefront addresses;
// - `dns_timeout`: a lookup the decision needs did not complete (timeout, SERVFAIL, refused, unreachable resolvers):
//   nothing is known, and the next run asks again.
// Lookups that answer "no such name" (ENOTFOUND) or "no record of this type" (ENODATA) are definite answers; every
// other failure of a lookup counts as `dns_timeout`.
import { BlockList, isIPv4, isIPv6 } from "node:net";

/** The error codes of a failed check, in the order of the file header. */
export const DNS_CHECK_ERRORS = [
  "txt_missing",
  "txt_mismatch",
  "cname_missing",
  "cname_wrong_target",
  "a_wrong_address",
  "dns_timeout",
] as const;

/** An error code of a failed check (`tenant_domains.last_check_error`). */
export type DnsCheckError = (typeof DNS_CHECK_ERRORS)[number];

/** The lookups the checks make: the methods of a `node:dns/promises` `Resolver` they use. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** The longest CNAME chain the routing check follows (a loop or a longer chain ends the walk). */
export const MAX_CNAME_HOPS = 8;

/** The `dns` error codes of a definite "no such name" or "no record of this type" answer. */
export const NOT_FOUND_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

/** The VM's public addresses, the only targets an apex domain's A and AAAA records may have. */
export interface StorefrontAddressSet {
  readonly ipv4?: string | undefined;
  readonly ipv6?: string | undefined;
}

/** What a check needs to know about a domain. */
export interface DomainCheckTarget {
  /** The custom host name, normalised (hostname-rules.ts): lower case, no trailing dot. */
  readonly hostname: string;
  /** `vx-verify-…`, the value `TXT _velexis.<host>` must hold. */
  readonly verificationToken: string;
  /** `<key>.<STOREFRONT_BASE_DOMAIN>`, the end of the CNAME chain. */
  readonly cnameTarget: string;
  readonly storefrontAddresses: StorefrontAddressSet;
}

/** How a verified domain routes to Velexis. */
export type DomainRouting = "cname" | "address";

/** The outcome of a check: both proofs hold, or the one error code of the first that does not. */
export type DomainCheckResult =
  | { readonly ok: true; readonly routing: DomainRouting }
  | { readonly ok: false; readonly error: DnsCheckError };

/** The answer of one lookup: the records, a definite "none", or no answer. */
type Lookup<T> =
  { readonly kind: "found"; readonly value: T } | { readonly kind: "none" } | { readonly kind: "failed" };

/** True when `error` is a definite "no such name" or "no record of this type" answer. */
export function isNotFound(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && NOT_FOUND_CODES.has(code);
}

/** Runs one lookup; an empty answer is "none" too. */
async function lookup<T extends readonly unknown[]>(query: () => Promise<T>): Promise<Lookup<T>> {
  try {
    const value = await query();
    return value.length === 0 ? { kind: "none" } : { kind: "found", value };
  } catch (error) {
    return isNotFound(error) ? { kind: "none" } : { kind: "failed" };
  }
}

/** A host name of a DNS answer as the checks compare it: lower case, without the trailing dot. */
export function normaliseDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** The `_velexis.<host>` name of the ownership record (PADR-0004 item 2). */
export function ownershipRecordName(hostname: string): string {
  return `_velexis.${hostname}`;
}

/** The ownership proof: `undefined` when it holds, else its error code. */
export async function checkOwnership(
  resolver: DnsResolver,
  hostname: string,
  verificationToken: string,
): Promise<DnsCheckError | undefined> {
  const records = await lookup(() => resolver.resolveTxt(ownershipRecordName(hostname)));
  if (records.kind === "failed") {
    return "dns_timeout";
  }
  if (records.kind === "none") {
    return "txt_missing";
  }
  // A TXT record may come split in character strings of at most 255 bytes: they form one value.
  const values = records.value.map((strings) => strings.join("").trim());
  return values.includes(verificationToken) ? undefined : "txt_mismatch";
}

/** Whether the CNAME chain of `hostname` reaches `target`, and whether the host has a CNAME at all. */
async function followCnameChain(
  resolver: DnsResolver,
  hostname: string,
  target: string,
): Promise<{ readonly reached: boolean; readonly hasCname: boolean } | "failed"> {
  const seen = new Set<string>([hostname]);
  let name = hostname;
  for (let hop = 0; hop < MAX_CNAME_HOPS; hop += 1) {
    const answer = await lookup(() => resolver.resolveCname(name));
    if (answer.kind === "failed") {
      return "failed";
    }
    if (answer.kind === "none") {
      return { reached: false, hasCname: hop > 0 };
    }
    const next = normaliseDnsName(answer.value[0] ?? "");
    if (next === target) {
      return { reached: true, hasCname: true };
    }
    if (next === "" || seen.has(next)) {
      return { reached: false, hasCname: true };
    }
    seen.add(next);
    name = next;
  }
  return { reached: false, hasCname: true };
}

/** The storefront addresses as a BlockList, so `2001:DB8::10` and `2001:db8:0::10` are one address. */
function addressList(addresses: StorefrontAddressSet): BlockList {
  const list = new BlockList();
  if (addresses.ipv4 !== undefined && isIPv4(addresses.ipv4)) {
    list.addAddress(addresses.ipv4, "ipv4");
  }
  if (addresses.ipv6 !== undefined && isIPv6(addresses.ipv6)) {
    list.addAddress(addresses.ipv6, "ipv6");
  }
  return list;
}

/** True when `address` (an A or AAAA answer) is one of the storefront addresses. */
export function isStorefrontAddress(address: string, addresses: StorefrontAddressSet): boolean {
  const family = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : undefined;
  return family !== undefined && addressList(addresses).check(address, family);
}

/** The routing proof: how the domain routes to Velexis, or the error code. */
export async function checkRouting(
  resolver: DnsResolver,
  target: Pick<DomainCheckTarget, "hostname" | "cnameTarget" | "storefrontAddresses">,
): Promise<{ readonly routing: DomainRouting } | { readonly error: DnsCheckError }> {
  const cnameTarget = normaliseDnsName(target.cnameTarget);
  const chain = await followCnameChain(resolver, target.hostname, cnameTarget);
  if (chain === "failed") {
    return { error: "dns_timeout" };
  }
  if (chain.reached) {
    return { routing: "cname" };
  }
  // A recursive resolver follows the CNAME chain for A and AAAA questions: these are the addresses the host serves.
  const [v4, v6] = await Promise.all([
    lookup(() => resolver.resolve4(target.hostname)),
    lookup(() => resolver.resolve6(target.hostname)),
  ]);
  if (v4.kind === "failed" || v6.kind === "failed") {
    return { error: "dns_timeout" };
  }
  const addresses = [...(v4.kind === "found" ? v4.value : []), ...(v6.kind === "found" ? v6.value : [])];
  if (
    addresses.length > 0 &&
    addresses.every((address) => isStorefrontAddress(address, target.storefrontAddresses))
  ) {
    return { routing: "address" };
  }
  if (chain.hasCname) {
    return { error: "cname_wrong_target" };
  }
  return { error: addresses.length === 0 ? "cname_missing" : "a_wrong_address" };
}

/**
 * Both proofs for one domain (file header), asked side by side: verified with its routing, or the error code of the
 * ownership proof when it fails, else that of the routing proof.
 */
export async function checkDomainRecords(
  resolver: DnsResolver,
  target: DomainCheckTarget,
): Promise<DomainCheckResult> {
  const [ownership, routing] = await Promise.all([
    checkOwnership(resolver, target.hostname, target.verificationToken),
    checkRouting(resolver, target),
  ]);
  if (ownership !== undefined) {
    return { ok: false, error: ownership };
  }
  return "routing" in routing ? { ok: true, routing: routing.routing } : { ok: false, error: routing.error };
}

/** True when `value` is an error code of DNS_CHECK_ERRORS. */
export function isDnsCheckError(value: unknown): value is DnsCheckError {
  return typeof value === "string" && (DNS_CHECK_ERRORS as readonly string[]).includes(value);
}

/** What each error code means, in the words of the `domain.failed` e-mail (the portal has its own, DNS_CHECK_ERRORS). */
export const DNS_CHECK_ERROR_TEXT: Readonly<Record<DnsCheckError, string>> = Object.freeze({
  txt_missing: "The TXT record was not found.",
  txt_mismatch: "The TXT record was found, but its value is not the one shown in the portal.",
  cname_missing: "Neither the CNAME record nor the A or AAAA records were found.",
  cname_wrong_target: "The CNAME record points to another host than the one shown in the portal.",
  a_wrong_address: "The A or AAAA record points to another address than the ones shown in the portal.",
  dns_timeout: "The DNS servers of the domain did not answer in time.",
});
