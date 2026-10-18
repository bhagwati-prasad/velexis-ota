// Entry module of the home page (index.html, ota/frontend/docs/pages.md §3), its only script (conventions §4). Pages
// are meaningful without JavaScript: the search form is a real GET form to /search.html. This module marks the
// document as enhanced, runs the shared start-up (src/boot.js: configuration, theme, header, footer, test banner,
// session) and then enhances the search form (src/components/search-form.js): location autocomplete, passengers,
// dates, multi-city legs and checks, pre-filled from the address (`/?from=LON&to=NYC`). Should enhancing fail, the
// plain form keeps working.
import { boot } from "../boot.js";
import { mount as mountSearchForm } from "../components/search-form.js";

document.documentElement.dataset.js = "on";

boot().then(({ client }) => {
  const form = document.querySelector("form[data-search-form]");
  if (!form) {
    return;
  }
  try {
    mountSearchForm(/** @type {HTMLFormElement} */ (form), {
      client,
      params: new URLSearchParams(location.search),
    });
  } catch (error) {
    globalThis.reportError?.(error);
  }
});
