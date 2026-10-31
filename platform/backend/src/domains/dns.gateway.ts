// The DNS gateway of custom domain verification (PBE-050; PADR-0004 item 3, flows/custom-domains.md step 2): the one
// place the platform makes DNS lookups. A `node:dns/promises` `Resolver` (c-ares) on the servers of DNS_RESOLVERS
// (public resolvers, `1.1.1.1,8.8.8.8` by default), never the VM's resolver or `/etc/hosts`, so a record created a
// minute ago is seen and a stale local cache never verifies a domain. Each server gets one try with a 5-second timeout
// (DNS_TIMEOUT_MS, DNS_TRIES): a lookup gives up after 5 seconds per configured server, and domain-checks.ts turns
// that into `dns_timeout`, which the next run asks again.
//
// The worker's DomainVerification reads the resolver through the DNS_RESOLVER token, so the integration tests put a
// fake in its place (no network in tests); domain-checks.ts, which takes the resolver as an argument, holds the logic.
import type { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Resolver } from "node:dns/promises";
import type { PlatformBackendConfig } from "../config";
import type { DnsResolver } from "./domain-checks";

/** The injection token of the worker's DnsResolver. */
export const DNS_RESOLVER = Symbol("DNS_RESOLVER");

/** How long one DNS server may take to answer one lookup (PADR-0004 item 3: 5 s). */
export const DNS_TIMEOUT_MS = 5_000;

/** How often each DNS server is asked before the next one is (c-ares `tries`). */
export const DNS_TRIES = 1;

/** A `node:dns` Resolver on `servers` (DNS_RESOLVERS items: an address with an optional port), with the timeouts above. */
export function createDnsResolver(servers: readonly string[]): DnsResolver {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  resolver.setServers([...servers]);
  return resolver;
}

/** The provider of DNS_RESOLVER: a resolver on the configured DNS_RESOLVERS. */
export const dnsResolverProvider: FactoryProvider<DnsResolver> = {
  provide: DNS_RESOLVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<PlatformBackendConfig, true>) =>
    createDnsResolver(config.get("DNS_RESOLVERS", { infer: true })),
};
