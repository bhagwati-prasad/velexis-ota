// The primary-host rule of the authentication pages (OFE-021; OADR-0006 Follow-ups, ADR-0018 "Custom domain
// lifecycle" step 5 and Follow-ups, ota/frontend/README.md §2 point 5). Cookies are host-only, so a session created on
// the OTA's sub-domain `acme.ota.example.com` does not exist on its custom domain `travel.acme.com`. Once the OTA's
// primary storefront host is a custom domain, the sign-in and sign-up pages on the sub-domain send the traveller to the
// same page on the primary host before any session is created, so sessions live on the host that e-mails and the
// console link to.
//
// The rule (`primaryHostRedirect`), from storefront.get alone (`primaryUrl` and `domains`, FIX-W38-OTA):
//
//   - only the sign-in and sign-up pages: `/account/sign-in.html` and `/account/sign-up.html`, and the same paths
//     without `.html`, which Caddy's `try_files {path}.html` serves too. Every other page keeps working on both hosts
//     (booking links in old e-mails, the verification and reset links, whose tokens leave the address bar before boot);
//   - only from the OTA's sub-domain: the page's host is the `domains` entry of kind `subdomain`. A custom domain never
//     redirects, so no two hosts can send a traveller back and forth (not even while one of them still holds a
//     configuration cached up to 5 minutes ago), and a host the configuration does not list (the dev server,
//     `vite preview`, a domain whose certificate the platform has not recorded yet) never redirects;
//   - only to the primary custom domain: the single `domains` entry marked `primary`, of kind `custom`, with a host
//     name the API itself accepts (`STOREFRONT_HOST_PATTERN` of the OTA backend), when `primaryUrl` is exactly
//     `https://<that host>` (with or without the final `/`). Anything else (the sub-domain is primary, two entries
//     marked primary, a `primaryUrl` that names another host, a port, credentials, a path or another scheme) is no
//     redirect. The target's origin comes from that host alone, never from the page's address, its query or `next`,
//     so nothing a link carries can choose where the traveller goes (no open redirect);
//   - path, query and fragment kept: `https://<primary host><pathname><search><hash>`, so `next` still leads back to
//     the page the traveller came from (the page checks it again as a path on its own host, lib/session.js).
//
// The configuration is the one boot already has, so the rule can be up to 5 minutes behind the platform (lib/config.js
// keeps it per tab and origin, OADR-0015 point 7): a tab that loaded a page of the sub-domain before a custom domain
// became primary signs in on the sub-domain until its copy expires, and one that loaded it before the primary flag moved
// back to the sub-domain (the OTA's choice, or the platform's TLS re-check) may still be sent to that custom domain.
//
// boot() applies it right after storefront.get (src/boot.js): with `location.replace`, so the sub-domain's page does not
// stay in the history, and neither auth.getSession nor the page module runs on the sub-domain.

/** The paths of the pages that create a session: sign-in and sign-up, as the pages link them and without `.html`. */
export const AUTH_PAGE_PATHS = Object.freeze([
  "/account/sign-in.html",
  "/account/sign-in",
  "/account/sign-up.html",
  "/account/sign-up",
]);

/** A storefront host name as the OTA backend accepts it (lower case, at least two labels, no port). */
export const STOREFRONT_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** @typedef {import("./config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {Pick<Location, "hostname" | "pathname" | "search" | "hash">} PageLocation */
/** @typedef {{ host: unknown, kind: unknown, primary: unknown }} DomainEntry */

/**
 * Whether `pathname` is the sign-in or the sign-up page.
 * @param {unknown} pathname
 * @returns {boolean}
 */
export const isAuthPage = (pathname) => typeof pathname === "string" && AUTH_PAGE_PATHS.includes(pathname);

/**
 * The `domains` entries of the configuration that look like domains (objects); none when `domains` is not a list.
 * @param {Partial<Pick<StorefrontConfig, "domains">>} config
 * @returns {DomainEntry[]}
 */
function domainsOf(config) {
  const domains = /** @type {unknown} */ (config.domains);
  return Array.isArray(domains)
    ? domains.filter(
        /** @returns {entry is DomainEntry} */ (entry) => entry !== null && typeof entry === "object",
      )
    : [];
}

/**
 * The host name of the OTA's primary custom domain (see the top of this file), or `null` while the sub-domain is
 * primary or when the configuration does not name one consistently.
 * @param {Partial<Pick<StorefrontConfig, "primaryUrl" | "domains">>} config
 * @returns {string | null}
 */
export function primaryCustomHost(config) {
  const primary = domainsOf(config).filter((domain) => domain.primary === true);
  const [domain] = primary;
  if (primary.length !== 1 || domain === undefined || domain.kind !== "custom") {
    return null;
  }
  const host = domain.host;
  if (typeof host !== "string" || !STOREFRONT_HOST_PATTERN.test(host)) {
    return null;
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(typeof config.primaryUrl === "string" ? config.primaryUrl : "");
  } catch {
    return null;
  }
  const exact =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hostname === host &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  return exact ? host : null;
}

/**
 * The page's host name in lower case, without the final dot of a fully qualified name.
 * @param {string} hostname
 */
const normalHost = (hostname) => hostname.toLowerCase().replace(/\.$/, "");

/**
 * Where the page must go before a session is created (see the top of this file): the same sign-in or sign-up page
 * on the OTA's primary custom domain, with the page's query and fragment; `null` when the page stays where it is.
 * @param {Partial<Pick<StorefrontConfig, "primaryUrl" | "domains">>} config the configuration of storefront.get
 * @param {PageLocation} location the page's address
 * @returns {string | null} an absolute `https:` URL on the primary custom domain, or `null`
 */
export function primaryHostRedirect(config, location) {
  if (!isAuthPage(location.pathname)) {
    return null;
  }
  const host = normalHost(location.hostname);
  const onSubdomain = domainsOf(config).some((domain) => domain.kind === "subdomain" && domain.host === host);
  const primary = primaryCustomHost(config);
  if (!onSubdomain || primary === null || primary === host) {
    return null;
  }
  const origin = `https://${primary}`;
  const target = new URL(`${origin}/`);
  target.pathname = location.pathname;
  target.search = location.search;
  target.hash = location.hash;
  // The path is one of AUTH_PAGE_PATHS and the query and fragment cannot change the origin; checked all the same.
  return target.origin === origin && isAuthPage(target.pathname) ? target.href : null;
}
