// The page header (partials/header.html, ota/frontend/README.md §5.1 point 3, §7): the OTA's name and logo, the currency
// selector and the account menu. The partial is static HTML that works without JavaScript; this component fills it
// from the configuration once boot() has it. Everything is set with textContent, checked attributes and createElement.
//
// The partial gives the header its final shape from the first paint, whatever storefront.get brings (OFE-030): a grid
// with the OTA's name on one line, the currency selector's place (`[data-header-currency]`) beside it, and on a phone
// the navigation on a row of its own under both; from `sm` the three share one row, and the name's column gives way to
// the navigation instead of pushing it onto a second row.
//
// - Logo: an uploaded logo (a same-origin asset path; the variant for dark backgrounds when the header colour is dark)
//   is shown next to the name, which stays the link's text. The API's `data:` placeholder badge is not shown here.
//   The name stays on one line, cut with an ellipsis when it is longer than its column (partials/header.html,
//   OFE-030), so a long name never makes the header grow; the link's text and its title keep the whole name.
// - Currency: a labelled `<select>` of `config.currencies` (only with two or more), preselected with the remembered
//   choice or the default currency, in the header's own place for it (`[data-header-currency]`, beside the name and
//   no higher than the name's line, so it moves nothing when it appears, OFE-030). A change calls
//   `onCurrencyChange(code)` (boot() announces it in the live region and tells the page) and shows the same text
//   visibly, "Prices will be shown in {currency} from your next search", as a small note under the header's right end
//   (`[data-currency-status]`, KI-020, FIX-W70-STOREFRONT). The note floats over the top padding of `main` (every
//   page's is at least 32 px; the note is at most two 14 px lines with 2 px padding), so it moves nothing; it is no
//   live region, so a screen reader hears the change once, from the live region. The prices on the page stay as they
//   are (WCAG 3.2.2): the next search uses the new currency, and the results page hides the note when it runs one
//   (`clearCurrencyStatus`); any other page loses it with the next navigation.
// - Account menu (lib/session.js): a sign-in link when signed out; the customer's first name, the account link and
//   "Sign out" (with the `client` given) when signed in. Hidden, with "My bookings", when the OTA has no customer
//   accounts (`features.customerAccounts = false`).

import { t } from "../lib/i18n.js";
import { renderAccountMenu } from "../lib/session.js";
import { NEUTRAL_PALETTE, isHexColor, safeImageUrl, textColorOn } from "../lib/theme.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontConfig"]} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/**
 * @typedef {object} HeaderProps
 * @property {StorefrontConfig} config
 * @property {SessionInfo | null} [session] the customer session (`null` until auth.getSession answers)
 * @property {string | null} [currency] the remembered currency choice; without one the default currency is selected
 * @property {(currency: string) => void} [onCurrencyChange] called with the code the traveller chose
 * @property {Location} [location] for the `next` of the sign-in link
 * @property {import("../lib/session.js").SessionClient | null} [client] the SDK client of the menu's sign-out
 */

const CURRENCY_SELECT_ID = "vx-currency";
/** The attribute of the visible note of a currency change (KI-020). */
const CURRENCY_STATUS = "data-currency-status";
/**
 * The note's classes: over the top padding of `main`, right-aligned with the header's content, above the page's own
 * content there but under the account menu's panel (`z-20`, lib/session.js); at most two lines of 14 px and 2 px of
 * padding (32 px), with a ring that takes no room.
 */
const CURRENCY_STATUS_CLASSES =
  "absolute top-0 right-4 z-10 max-w-[calc(100%-2rem)] rounded-b-ui bg-panel px-2 py-0.5 text-xs/[14px] text-ink shadow-sm ring-1 ring-muted/30";

/**
 * Shows the visible note of a currency change below the header (KI-020): the live region's text, in a zero-height
 * place at the header's end, so nothing on the page moves.
 * @param {HTMLElement} root the page's `<header>`
 * @param {string} code
 */
function showCurrencyStatus(root, code) {
  const doc = root.ownerDocument;
  let note = /** @type {HTMLElement | null} */ (root.querySelector(`[${CURRENCY_STATUS}]`));
  if (!note) {
    const place = doc.createElement("div");
    place.className = "relative mx-auto h-0 max-w-6xl";
    place.dataset.currencyStatusPlace = "";
    note = doc.createElement("p");
    note.setAttribute(CURRENCY_STATUS, "");
    note.className = CURRENCY_STATUS_CLASSES;
    place.append(note);
    root.append(place);
  }
  note.textContent = t("header.currencyChanged", { currency: code });
  note.hidden = false;
}

/**
 * Hides the visible note of a currency change (KI-020): the results page calls it when it runs a new search, which uses
 * the new currency.
 * @param {Document} [doc]
 */
export function clearCurrencyStatus(doc = document) {
  const note = /** @type {HTMLElement | null} */ (doc.querySelector(`body > header [${CURRENCY_STATUS}]`));
  if (note) {
    note.hidden = true;
    note.textContent = "";
  }
}

/**
 * The logo for the header, or `null`: the dark variant when the header colour is dark and one is uploaded, else the
 * main logo; same-origin asset paths only.
 * @param {StorefrontConfig["branding"] | undefined} branding
 * @param {string} headerColor the applied `--vx-secondary`
 */
function headerLogo(branding, headerColor) {
  const dark = textColorOn(headerColor) === "#ffffff";
  const candidates = dark ? [branding?.logoDarkUrl, branding?.logoUrl] : [branding?.logoUrl];
  for (const candidate of candidates) {
    const url = safeImageUrl(candidate);
    if (url !== null && url.startsWith("/")) {
      return url;
    }
  }
  return null;
}

/**
 * Fills the brand link: the logo image, if any, and the OTA's name as its text.
 * @param {HTMLAnchorElement} link
 * @param {StorefrontConfig} config
 */
function renderBrand(link, config) {
  const doc = link.ownerDocument;
  const applied = doc.documentElement.style.getPropertyValue("--vx-secondary").trim();
  const logo = headerLogo(config.branding, isHexColor(applied) ? applied : NEUTRAL_PALETTE.secondary);
  /** @type {Node[]} */
  const children = [];
  if (logo !== null) {
    const image = doc.createElement("img");
    image.src = logo;
    image.alt = "";
    image.height = 28;
    // As high as the name's line and aligned to its top, so the logo never makes the header row higher.
    image.className = "mr-2 inline-block h-7 w-auto align-top";
    image.dataset.logo = "";
    children.push(image);
  }
  children.push(doc.createTextNode(config.name));
  link.replaceChildren(...children);
  // The whole name for a pointer when the line cuts it (the link's text is the whole name for everyone else).
  link.title = config.name;
}

/**
 * The currency selector with its label, or `null` with fewer than two currencies.
 * @param {Document} doc
 * @param {StorefrontConfig} config
 * @param {string} selected
 * @param {(currency: string) => void} onChange
 */
function currencyItem(doc, config, selected, onChange) {
  const currencies = Array.isArray(config.currencies) ? config.currencies : [];
  if (currencies.length < 2) {
    return null;
  }
  const item = doc.createElement("div");
  item.dataset.slot = "currency";
  item.className = "flex items-center";
  const label = doc.createElement("label");
  label.htmlFor = CURRENCY_SELECT_ID;
  label.className = "sr-only";
  label.textContent = t("header.currency");
  const select = doc.createElement("select");
  select.id = CURRENCY_SELECT_ID;
  select.name = "currency";
  // 28 px high: the name's line height, so the selector never makes the header row higher (and a 24 px target).
  select.className = "h-7 rounded-ui border border-current bg-secondary px-2 text-sm text-on-secondary";
  for (const currency of currencies) {
    const option = doc.createElement("option");
    option.value = currency.code;
    option.textContent =
      currency.symbol && currency.symbol !== currency.code
        ? t("header.currencyOption", { code: currency.code, symbol: currency.symbol })
        : currency.code;
    option.selected = currency.code === selected;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  item.append(label, select);
  return item;
}

/**
 * Mounts the header component on the page's `<header>` (partials/header.html). `update({ session })` re-renders the
 * account menu only; `update({ config })` or `update({ currency })` the brand and the currency selector too.
 * @param {HTMLElement} root
 * @param {HeaderProps} props
 * @returns {{ update: (props: Partial<HeaderProps>) => void, destroy: () => void }}
 */
export function mount(root, props) {
  const doc = root.ownerDocument;
  /** @type {HeaderProps} */
  let current = { session: null, currency: null, ...props };
  const brand = /** @type {HTMLAnchorElement | null} */ (root.querySelector('a[data-field="brandName"]'));
  const menu = /** @type {HTMLElement | null} */ (root.querySelector('[data-slot="account-menu"]'));
  const bookings = /** @type {HTMLElement | null} */ (
    root.querySelector('a[href="/bookings.html"]')?.closest("li") ?? null
  );
  /**
   * The header's place for the currency selector (partials/header.html); a header without it gets no selector. The card
   * page removes the selector itself (`[data-slot="currency"]`, checkout-pay-card.js).
   */
  const currencyPlace = root.querySelector("[data-header-currency]");
  /** @type {HTMLElement | null} */
  let currency = null;

  const renderBrandAndCurrency = () => {
    const { config } = current;
    if (brand) {
      renderBrand(brand, config);
    }
    currency?.remove();
    currency = currencyItem(doc, config, current.currency ?? config.defaultCurrency, (code) => {
      current = { ...current, currency: code };
      showCurrencyStatus(root, code);
      current.onCurrencyChange?.(code);
    });
    if (currency && currencyPlace) {
      currencyPlace.append(currency);
    } else {
      currency = null;
    }
  };

  const renderMenu = () => {
    const accounts = current.config.features?.customerAccounts !== false;
    if (bookings) {
      bookings.hidden = !accounts;
    }
    if (menu) {
      menu.hidden = !accounts;
      if (accounts) {
        renderAccountMenu(menu, current.session ?? null, {
          ...(current.location ? { location: current.location } : {}),
          client: current.client ?? null,
        });
      }
    }
  };

  renderBrandAndCurrency();
  renderMenu();
  return {
    update(next) {
      const brandChanged = "config" in next || "currency" in next;
      current = { ...current, ...next };
      if (brandChanged) {
        renderBrandAndCurrency();
      }
      renderMenu();
    },
    destroy() {
      currency?.remove();
      currency = null;
      root.querySelector("[data-currency-status-place]")?.remove();
    },
  };
}
