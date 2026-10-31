// The host name rules of a custom storefront domain (PBE-049; PADR-0004 item 1, flows/custom-domains.md step 1): the
// normalisation (white space, IDN to punycode, case, trailing dot), the syntax and length rules, IP addresses, the
// Velexis hosts of decisions.md §4 and STOREFRONT_BASE_DOMAIN, the shared-suffix deny list, and the verification value
// of PADR-0004 item 2. Pure functions: no service, no clock.
import { validateInvalidation } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import {
  checkCustomHostname,
  customHostnameOrThrow,
  DECISIONS_PLACEHOLDER_HOSTS,
  HOSTNAME_PATTERN,
  isAtOrBelow,
  MAX_HOSTNAME_LENGTH,
  newVerificationToken,
  SHARED_SUFFIX_DENY_LIST,
  velexisHostsOf,
  VERIFICATION_TOKEN_PATTERN,
  type HostnameRules,
  type VelexisHostConfig,
} from "./hostname-rules";
import { TLS_ASK_HOST_PATTERN } from "./tls-ask.service";

/** The hosts of platform/backend/.env.example and of the test applications (local URLs, placeholder base domain). */
const DEVELOPMENT: VelexisHostConfig = {
  STOREFRONT_BASE_DOMAIN: "ota.example.com",
  PUBLIC_PORTAL_URL: "http://localhost:3000",
  PUBLIC_PLATFORM_ADMIN_URL: "http://localhost:3001",
  PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
};

/** A VM whose real hosts replaced the placeholders of decisions.md §4 (documentation names, RFC 2606). */
const VM: VelexisHostConfig = {
  STOREFRONT_BASE_DOMAIN: "shops.velexis-travel.test",
  PUBLIC_PORTAL_URL: "https://platform.velexis-travel.test",
  PUBLIC_PLATFORM_ADMIN_URL: "https://admin.platform.velexis-travel.test",
  PUBLIC_OTA_ADMIN_URL: "https://admin.shops.velexis-travel.test",
};

const rulesOf = (config: VelexisHostConfig): HostnameRules => ({ velexisHosts: velexisHostsOf(config) });
const DEV_RULES = rulesOf(DEVELOPMENT);
const VM_RULES = rulesOf(VM);

/** The stored host of `input` under the development rules, or the problem. */
function outcome(input: string, rules: HostnameRules = DEV_RULES): string {
  const check = checkCustomHostname(input, rules);
  return check.ok ? check.hostname : `refused: ${check.problem}`;
}

/** The error code `customHostnameOrThrow` throws for `input`, or `undefined` when it accepts it. */
function errorCode(input: string, rules: HostnameRules): string | undefined {
  try {
    customHostnameOrThrow(input, rules);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details).toBeUndefined();
    return (error as AppError).code;
  }
}

/** `labels` labels of `size` letters (`aaa…`, `bbb…`, …) under `example.net`. */
function longHost(labels: number, size: number): string {
  const parts = Array.from({ length: labels }, (_, index) =>
    String.fromCharCode(97 + (index % 26)).repeat(size),
  );
  return [...parts, "example", "net"].join(".");
}

describe("checkCustomHostname: normalisation", () => {
  it("[PBE-049 AC1] stores Travel.Acme.com. as travel.acme.com [PF-41 AC1]", () => {
    expect(customHostnameOrThrow("Travel.Acme.com.", DEV_RULES)).toBe("travel.acme.com");
    expect(customHostnameOrThrow("Travel.Acme.com.", VM_RULES)).toBe("travel.acme.com");
  });

  it.each([
    ["travel.acme.com", "travel.acme.com"],
    ["TRAVEL.ACME.COM", "travel.acme.com"],
    ["acme.com.", "acme.com"],
    ["  travel.acme.com \t", "travel.acme.com"],
    ["Bücher.example.net", "xn--bcher-kva.example.net"],
    ["xn--bcher-kva.example.net", "xn--bcher-kva.example.net"],
    ["reisen.münchen.de", "reisen.xn--mnchen-3ya.de"],
    ["travel。acme.com", "travel.acme.com"],
    ["EXAMPLE.ｃｏｍ", "example.com"],
    ["a-b.c-d.example", "a-b.c-d.example"],
    ["123.example.net", "123.example.net"],
    ["travel.acme-travel.example.com", "travel.acme-travel.example.com"],
  ])("stores %j as %j", (input, stored) => {
    expect(outcome(input)).toBe(stored);
  });

  it("answers host names that TLS ask, the tlsask: key and the domain invalidation event accept", () => {
    expect(HOSTNAME_PATTERN.source).toBe(TLS_ASK_HOST_PATTERN.source);
    for (const input of ["Travel.Acme.com.", "Bücher.example.net", "a.b.c.d.example.org", longHost(3, 63)]) {
      const check = checkCustomHostname(input, DEV_RULES);
      expect(check.ok, input).toBe(true);
      const hostname = check.ok ? check.hostname : "";
      expect(() => validateInvalidation({ v: 1, type: "domain", hostname }), input).not.toThrow();
    }
  });
});

describe("checkCustomHostname: refusals", () => {
  it("[PBE-049 AC1] answers DOMAIN_INVALID for acme.ota.example.com, 1.2.3.4 and x.github.io", () => {
    for (const rules of [DEV_RULES, VM_RULES]) {
      expect(errorCode("acme.ota.example.com", rules)).toBe("DOMAIN_INVALID");
      expect(errorCode("1.2.3.4", rules)).toBe("DOMAIN_INVALID");
      expect(errorCode("x.github.io", rules)).toBe("DOMAIN_INVALID");
    }
    expect(outcome("acme.ota.example.com")).toBe("refused: velexis_host");
    expect(outcome("1.2.3.4")).toBe("refused: ip_address");
    expect(outcome("x.github.io")).toBe("refused: shared_suffix");
  });

  it.each([
    ["1.2.3.4."],
    ["0x7f.1"],
    ["192.0.2.10"],
    ["2001:db8::1"],
    ["[2001:db8::1]"],
    ["::ffff:192.0.2.1"],
  ])("refuses the IP address %j", (input) => {
    expect(outcome(input)).toBe("refused: ip_address");
  });

  it.each([
    [""],
    ["   "],
    ["localhost"],
    ["com"],
    ["acme.com.."],
    [".acme.com"],
    ["travel..acme.com"],
    ["-travel.acme.com"],
    ["travel-.acme.com"],
    ["travel_shop.acme.com"],
    ["*.acme.com"],
    ["travel acme.com"],
    ["travel.acme.com/x"],
    ["travel.acme.com\\x"],
    ["travel.acme.com?x"],
    ["travel.acme.com#x"],
    ["travel.acme.com:443"],
    ["https://travel.acme.com"],
    ["user@travel.acme.com"],
    ["ex%41mple.com"],
    ["travel.acme.com／x"],
    ["travel.acme.123"],
    ["travel.acme.1com"],
    ["xn--zz.example.com"],
    [`${"a".repeat(64)}.example.net`],
  ])("refuses the malformed host %j", (input) => {
    expect(outcome(input)).toBe("refused: syntax");
  });

  it("accepts 253 characters and refuses 254, also when IDN labels grow into punycode", () => {
    const longest = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.net`;
    const tooLong = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.net`;
    expect([longest.length, tooLong.length]).toEqual([MAX_HOSTNAME_LENGTH, MAX_HOSTNAME_LENGTH + 1]);
    expect(outcome(longest)).toBe(longest);
    expect(outcome(`${longest}.`)).toBe(longest);
    expect(outcome(tooLong)).toBe("refused: too_long");
    // Twelve Japanese characters become a 39-character punycode label: six of them fit in 253 characters, seven do
    // not, although the typed name has only 102.
    const label = "旅行予約東京大阪京都札幌";
    const six = Array.from({ length: 6 }, () => label).join(".");
    const seven = Array.from({ length: 7 }, () => label).join(".");
    expect(outcome(`${six}.example.net`)).toHaveLength(251);
    expect(`${seven}.example.net`.length).toBeLessThan(MAX_HOSTNAME_LENGTH);
    expect(outcome(`${seven}.example.net`)).toBe("refused: too_long");
  });

  it("refuses STOREFRONT_BASE_DOMAIN, every host below it and the placeholder hosts of decisions.md §4", () => {
    for (const host of [
      "ota.example.com",
      "acme.ota.example.com",
      "ACME.OTA.EXAMPLE.COM.",
      "shop.acme.ota.example.com",
      "admin.ota.example.com",
      "api.ota.example.com",
      "platform.example.com",
      "admin.platform.example.com",
      "api.platform.example.com",
      "x.api.platform.example.com",
    ]) {
      expect(outcome(host), host).toBe("refused: velexis_host");
    }
    // Lookalikes outside the zones are no Velexis hosts.
    for (const host of ["notota.example.com", "ota.example.com.evil.example.net", "myplatform.example.com"]) {
      expect(outcome(host), host).toBe(host);
    }
  });

  it("refuses the configured hosts of a VM: the storefront domain, the portal, the platform admin and the OTA admin, and below", () => {
    expect(velexisHostsOf(VM)).toEqual([
      "shops.velexis-travel.test",
      "platform.velexis-travel.test",
      "admin.platform.velexis-travel.test",
      "admin.shops.velexis-travel.test",
      ...DECISIONS_PLACEHOLDER_HOSTS,
    ]);
    for (const host of [
      "shops.velexis-travel.test",
      "acme.shops.velexis-travel.test",
      "platform.velexis-travel.test",
      "api.platform.velexis-travel.test",
      "admin.platform.velexis-travel.test",
      "admin.shops.velexis-travel.test",
      "acme.ota.example.com",
    ]) {
      expect(outcome(host, VM_RULES), host).toBe("refused: velexis_host");
    }
    expect(outcome("velexis-travel.test", VM_RULES)).toBe("velexis-travel.test");
    expect(outcome("travel.acme.com", VM_RULES)).toBe("travel.acme.com");
  });

  it("refuses every shared suffix of the deny list and the hosts below it, and nothing that only ends like one", () => {
    for (const suffix of SHARED_SUFFIX_DENY_LIST) {
      expect(outcome(suffix), suffix).toBe("refused: shared_suffix");
      expect(outcome(`acme.${suffix}`), suffix).toBe("refused: shared_suffix");
      expect(outcome(`Shop.Acme.${suffix.toUpperCase()}.`), suffix).toBe("refused: shared_suffix");
    }
    expect(outcome("x.github.io")).toBe("refused: shared_suffix");
    expect(outcome("mygithub.io")).toBe("mygithub.io");
    expect(outcome("github.io.example.net")).toBe("github.io.example.net");
  });
});

describe("the deny list and the Velexis hosts", () => {
  it("keeps the deny list sorted, without duplicates, in its stored form, with the suffixes the flow and the contract name", () => {
    expect([...SHARED_SUFFIX_DENY_LIST].sort()).toEqual(SHARED_SUFFIX_DENY_LIST);
    expect(new Set(SHARED_SUFFIX_DENY_LIST).size).toBe(SHARED_SUFFIX_DENY_LIST.length);
    for (const suffix of SHARED_SUFFIX_DENY_LIST) {
      expect(HOSTNAME_PATTERN.test(suffix), suffix).toBe(true);
    }
    expect(SHARED_SUFFIX_DENY_LIST).toEqual(
      expect.arrayContaining(["github.io", "herokuapp.com", "vercel.app", "netlify.app"]),
    );
    expect(Object.isFrozen(SHARED_SUFFIX_DENY_LIST)).toBe(true);
  });

  it("derives the development hosts without duplicates, and matches zones on label boundaries", () => {
    expect(velexisHostsOf(DEVELOPMENT)).toEqual([
      "ota.example.com",
      "localhost",
      ...DECISIONS_PLACEHOLDER_HOSTS.filter((host) => host !== "ota.example.com"),
    ]);
    expect(isAtOrBelow("ota.example.com", "ota.example.com")).toBe(true);
    expect(isAtOrBelow("a.ota.example.com", "ota.example.com")).toBe(true);
    expect(isAtOrBelow("aota.example.com", "ota.example.com")).toBe(false);
    expect(isAtOrBelow("example.com", "ota.example.com")).toBe(false);
  });
});

describe("newVerificationToken", () => {
  it("answers vx-verify- and 32 Crockford base32 characters, fresh each time, over the whole alphabet", () => {
    const tokens = Array.from({ length: 500 }, () => newVerificationToken());

    for (const token of tokens) {
      expect(token).toMatch(VERIFICATION_TOKEN_PATTERN);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
    // 16 000 random characters: every one of the 32 symbols shows up, at the first position as well as elsewhere.
    const used = new Set(tokens.flatMap((token) => [...token.slice("vx-verify-".length)]));
    expect(used.size).toBe(32);
    expect(new Set(tokens.map((token) => token.charAt("vx-verify-".length))).size).toBeGreaterThan(16);
  });
});
