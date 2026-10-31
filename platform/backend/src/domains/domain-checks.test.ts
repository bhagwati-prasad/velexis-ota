// The DNS checks of a custom storefront domain (PBE-050; PADR-0004 items 2 and 3, flows/custom-domains.md step 2,
// scope PF-41 AC2) with a fake resolver: every error code comes from its own case, and correct records verify the
// domain by either routing option. Pure functions: no network, no clock.
import { describe, expect, it } from "vitest";
import {
  checkDomainRecords,
  checkOwnership,
  checkRouting,
  DNS_CHECK_ERROR_TEXT,
  DNS_CHECK_ERRORS,
  isDnsCheckError,
  isNotFound,
  isStorefrontAddress,
  MAX_CNAME_HOPS,
  normaliseDnsName,
  ownershipRecordName,
  type DnsResolver,
  type DomainCheckTarget,
} from "./domain-checks";

/** The record types the checks ask for. */
type RecordType = "TXT" | "CNAME" | "A" | "AAAA";

/** A `dns` error as `node:dns` rejects with it (`code` is what the checks read). */
function dnsError(code: string): Error {
  return Object.assign(new Error(`query failed: ${code}`), { code });
}

/**
 * A resolver over a record table: `records["TXT _velexis.travel.example.net"] = [["vx-verify-…"]]`. A name or type
 * without records answers ENODATA when the name has records of another type, else ENOTFOUND (NXDOMAIN), as a public
 * resolver does; `failures` makes one question fail with a code instead. Every question is recorded.
 */
class FakeResolver implements DnsResolver {
  readonly records = new Map<string, unknown[]>();
  readonly failures = new Map<string, string>();
  readonly asked: string[] = [];

  set(type: RecordType, name: string, values: unknown[]): this {
    this.records.set(`${type} ${name}`, values);
    return this;
  }

  fail(type: RecordType, name: string, code: string): this {
    this.failures.set(`${type} ${name}`, code);
    return this;
  }

  private answer<T>(type: RecordType, name: string): Promise<T[]> {
    const key = `${type} ${name}`;
    this.asked.push(key);
    const failure = this.failures.get(key);
    if (failure !== undefined) {
      return Promise.reject(dnsError(failure));
    }
    const values = this.records.get(key);
    if (values !== undefined) {
      return Promise.resolve(values as T[]);
    }
    const nameExists = [...this.records.keys()].some((entry) => entry.endsWith(` ${name}`));
    return Promise.reject(dnsError(nameExists ? "ENODATA" : "ENOTFOUND"));
  }

  resolveTxt(hostname: string): Promise<string[][]> {
    return this.answer("TXT", hostname);
  }

  resolveCname(hostname: string): Promise<string[]> {
    return this.answer("CNAME", hostname);
  }

  resolve4(hostname: string): Promise<string[]> {
    return this.answer("A", hostname);
  }

  resolve6(hostname: string): Promise<string[]> {
    return this.answer("AAAA", hostname);
  }
}

// Documentation names and addresses only (RFC 2606, RFC 5737, RFC 3849).
const HOST = "travel.example.net";
const APEX = "example.org";
const TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";
const OTHER_TOKEN = "vx-verify-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TARGET = "acme.ota.example.com";
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

const target = (overrides: Partial<DomainCheckTarget> = {}): DomainCheckTarget => ({
  hostname: HOST,
  verificationToken: TOKEN,
  cnameTarget: TARGET,
  storefrontAddresses: { ipv4: IPV4, ipv6: IPV6 },
  ...overrides,
});

/** A resolver where `host` holds the ownership record and nothing else yet. */
const owned = (host = HOST, values: string[][] = [[TOKEN]]): FakeResolver =>
  new FakeResolver().set("TXT", ownershipRecordName(host), values);

describe("checkDomainRecords: correct records verify the domain", () => {
  it("[PBE-050 AC1] verifies a CNAME to the OTA's sub-domain with the TXT record", async () => {
    const resolver = owned().set("CNAME", HOST, [TARGET]);

    await expect(checkDomainRecords(resolver, target())).resolves.toEqual({ ok: true, routing: "cname" });
    // The chain reached the target: no address was asked for.
    expect(resolver.asked.filter((question) => /^(A|AAAA) /.test(question))).toEqual([]);
  });

  it("[PBE-050 AC1] verifies a CNAME chain that reaches the sub-domain, with a trailing dot and upper case", async () => {
    const resolver = owned()
      .set("CNAME", HOST, ["Shop.Example.net."])
      .set("CNAME", "shop.example.net", [`${TARGET.toUpperCase()}.`]);

    await expect(checkDomainRecords(resolver, target())).resolves.toEqual({ ok: true, routing: "cname" });
  });

  it("[PBE-050 AC1] verifies an apex whose A and AAAA records are the storefront addresses", async () => {
    const resolver = owned(APEX).set("A", APEX, [IPV4]).set("AAAA", APEX, ["2001:DB8:0:0::10"]);

    await expect(checkDomainRecords(resolver, target({ hostname: APEX }))).resolves.toEqual({
      ok: true,
      routing: "address",
    });
  });

  it("[PBE-050 AC1] verifies an apex with an A record only, and without STOREFRONT_IPV6", async () => {
    const resolver = owned(APEX).set("A", APEX, [IPV4]);

    await expect(
      checkDomainRecords(resolver, target({ hostname: APEX, storefrontAddresses: { ipv4: IPV4 } })),
    ).resolves.toEqual({ ok: true, routing: "address" });
  });

  it("[PBE-050 AC1] verifies a CNAME elsewhere whose addresses are all storefront addresses (the address rule)", async () => {
    const resolver = owned()
      .set("CNAME", HOST, ["edge.example.net"])
      .set("A", HOST, [IPV4])
      .set("AAAA", HOST, [IPV6]);

    await expect(checkDomainRecords(resolver, target())).resolves.toEqual({ ok: true, routing: "address" });
  });

  it("[PBE-050 AC1] finds the value among several TXT records, joined from its character strings", async () => {
    const resolver = owned(HOST, [
      ["v=spf1 -all"],
      [TOKEN.slice(0, 12), TOKEN.slice(12)],
      [" unrelated "],
    ]).set("CNAME", HOST, [TARGET]);

    await expect(checkDomainRecords(resolver, target())).resolves.toEqual({ ok: true, routing: "cname" });
  });
});

describe("checkDomainRecords: every error code comes from its case", () => {
  it("[PBE-050 AC1] txt_missing: no TXT record at _velexis.<host> (NXDOMAIN, or no TXT there)", async () => {
    const nxdomain = new FakeResolver().set("CNAME", HOST, [TARGET]);
    const nodata = new FakeResolver()
      .set("CNAME", HOST, [TARGET])
      .set("A", ownershipRecordName(HOST), [IPV4]);
    const empty = owned(HOST, []).set("CNAME", HOST, [TARGET]);

    for (const resolver of [nxdomain, nodata, empty]) {
      await expect(checkDomainRecords(resolver, target())).resolves.toEqual({
        ok: false,
        error: "txt_missing",
      });
    }
  });

  it("[PBE-050 AC1] txt_mismatch: TXT records exist, none holds the value", async () => {
    const resolver = owned(HOST, [[OTHER_TOKEN], [`${TOKEN}x`], [TOKEN.slice(1)]]).set("CNAME", HOST, [
      TARGET,
    ]);

    await expect(checkDomainRecords(resolver, target())).resolves.toEqual({
      ok: false,
      error: "txt_mismatch",
    });
  });

  it("[PBE-050 AC1] cname_missing: neither a CNAME nor an A or AAAA record", async () => {
    await expect(checkDomainRecords(owned(), target())).resolves.toEqual({
      ok: false,
      error: "cname_missing",
    });
  });

  it("[PBE-050 AC1] cname_wrong_target: the CNAME chain ends elsewhere and its addresses are not Velexis'", async () => {
    const elsewhere = owned().set("CNAME", HOST, ["other.ota.example.com"]).set("A", HOST, ["198.51.100.7"]);
    const noAddresses = owned().set("CNAME", HOST, ["parked.example.net"]);
    const someWrong = owned().set("CNAME", HOST, ["edge.example.net"]).set("A", HOST, [IPV4, "198.51.100.7"]);

    for (const resolver of [elsewhere, noAddresses, someWrong]) {
      await expect(checkDomainRecords(resolver, target())).resolves.toEqual({
        ok: false,
        error: "cname_wrong_target",
      });
    }
  });

  it("[PBE-050 AC1] cname_wrong_target: a CNAME loop or a chain longer than MAX_CNAME_HOPS ends the walk", async () => {
    const loop = owned().set("CNAME", HOST, ["a.example.net"]).set("CNAME", "a.example.net", [HOST]);
    const long = owned();
    for (let hop = 0; hop <= MAX_CNAME_HOPS; hop += 1) {
      long.set("CNAME", hop === 0 ? HOST : `hop${hop}.example.net`, [`hop${hop + 1}.example.net`]);
    }
    long.set("CNAME", `hop${MAX_CNAME_HOPS + 1}.example.net`, [TARGET]);

    for (const resolver of [loop, long]) {
      await expect(checkDomainRecords(resolver, target())).resolves.toEqual({
        ok: false,
        error: "cname_wrong_target",
      });
    }
    expect(long.asked.filter((question) => question.startsWith("CNAME "))).toHaveLength(MAX_CNAME_HOPS);
  });

  it("[PBE-050 AC1] a_wrong_address: no CNAME, and an A or AAAA record outside the storefront addresses", async () => {
    const wrongV4 = owned(APEX).set("A", APEX, ["198.51.100.7"]);
    const oneWrong = owned(APEX).set("A", APEX, [IPV4]).set("AAAA", APEX, ["2001:db8::99"]);
    const v6WithoutConfig = owned(APEX).set("A", APEX, [IPV4]).set("AAAA", APEX, [IPV6]);

    await expect(checkDomainRecords(wrongV4, target({ hostname: APEX }))).resolves.toEqual({
      ok: false,
      error: "a_wrong_address",
    });
    await expect(checkDomainRecords(oneWrong, target({ hostname: APEX }))).resolves.toEqual({
      ok: false,
      error: "a_wrong_address",
    });
    // Without STOREFRONT_IPV6 no AAAA record is a storefront address.
    await expect(
      checkDomainRecords(v6WithoutConfig, target({ hostname: APEX, storefrontAddresses: { ipv4: IPV4 } })),
    ).resolves.toEqual({ ok: false, error: "a_wrong_address" });
  });

  it("[PBE-050 AC1] dns_timeout: a lookup the decision needs fails with anything but NXDOMAIN or NODATA", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED", "ECANCELLED"]) {
      const txt = new FakeResolver()
        .fail("TXT", ownershipRecordName(HOST), code)
        .set("CNAME", HOST, [TARGET]);
      const cname = owned().fail("CNAME", HOST, code);
      const secondHop = owned()
        .set("CNAME", HOST, ["shop.example.net"])
        .fail("CNAME", "shop.example.net", code);
      const address = owned(APEX).set("A", APEX, [IPV4]).fail("AAAA", APEX, code);

      for (const [resolver, hostname] of [
        [txt, HOST],
        [cname, HOST],
        [secondHop, HOST],
        [address, APEX],
      ] as const) {
        await expect(checkDomainRecords(resolver, target({ hostname })), code).resolves.toEqual({
          ok: false,
          error: "dns_timeout",
        });
      }
    }
    // An error without a `dns` code (a bug of the resolver) is no answer either.
    const broken: DnsResolver = {
      resolveTxt: () => Promise.reject(new TypeError("broken")),
      resolveCname: () => Promise.resolve([TARGET]),
      resolve4: () => Promise.resolve([]),
      resolve6: () => Promise.resolve([]),
    };
    await expect(checkDomainRecords(broken, target())).resolves.toEqual({ ok: false, error: "dns_timeout" });
  });

  it("[PBE-050 AC1] reports the ownership error before the routing error when both fail", async () => {
    await expect(checkDomainRecords(new FakeResolver(), target())).resolves.toEqual({
      ok: false,
      error: "txt_missing",
    });
    const mismatch = owned(HOST, [[OTHER_TOKEN]]).set("A", HOST, ["198.51.100.7"]);
    await expect(checkDomainRecords(mismatch, target())).resolves.toEqual({
      ok: false,
      error: "txt_mismatch",
    });
  });

  it("produces exactly the six codes of the portal, each with the words of the e-mail", () => {
    expect([...DNS_CHECK_ERRORS]).toEqual([
      "txt_missing",
      "txt_mismatch",
      "cname_missing",
      "cname_wrong_target",
      "a_wrong_address",
      "dns_timeout",
    ]);
    expect(Object.keys(DNS_CHECK_ERROR_TEXT).sort()).toEqual([...DNS_CHECK_ERRORS].sort());
    for (const code of DNS_CHECK_ERRORS) {
      expect(isDnsCheckError(code)).toBe(true);
      // The column holds at most a short reason (the document's `lastCheckError`: 500 characters).
      expect(code.length).toBeLessThanOrEqual(500);
    }
    expect(isDnsCheckError("TXT_MISSING")).toBe(false);
    expect(isDnsCheckError(undefined)).toBe(false);
  });
});

describe("the parts of the checks", () => {
  it("asks the ownership record at _velexis.<host>", async () => {
    const resolver = owned();

    await expect(checkOwnership(resolver, HOST, TOKEN)).resolves.toBeUndefined();
    expect(resolver.asked).toEqual([`TXT _velexis.${HOST}`]);
  });

  it("asks the addresses only when the chain does not reach the target", async () => {
    const resolver = new FakeResolver().set("A", APEX, [IPV4]);

    await expect(checkRouting(resolver, target({ hostname: APEX }))).resolves.toEqual({ routing: "address" });
    expect([...resolver.asked].sort()).toEqual([`A ${APEX}`, `AAAA ${APEX}`, `CNAME ${APEX}`]);
  });

  it("compares addresses by value within their family", () => {
    const addresses = { ipv4: IPV4, ipv6: IPV6 };

    expect(isStorefrontAddress(IPV4, addresses)).toBe(true);
    expect(isStorefrontAddress("2001:0db8:0000:0000:0000:0000:0000:0010", addresses)).toBe(true);
    expect(isStorefrontAddress("203.0.113.11", addresses)).toBe(false);
    expect(isStorefrontAddress("2001:db8::11", addresses)).toBe(false);
    expect(isStorefrontAddress("not-an-address", addresses)).toBe(false);
    expect(isStorefrontAddress(IPV4, {})).toBe(false);
  });

  it("reads NXDOMAIN and NODATA as definite answers and normalises DNS names", () => {
    expect(isNotFound(dnsError("ENOTFOUND"))).toBe(true);
    expect(isNotFound(dnsError("ENODATA"))).toBe(true);
    expect(isNotFound(dnsError("ETIMEOUT"))).toBe(false);
    expect(isNotFound(new Error("no code"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
    expect(normaliseDnsName(" Acme.OTA.Example.com. ")).toBe("acme.ota.example.com");
  });
});
