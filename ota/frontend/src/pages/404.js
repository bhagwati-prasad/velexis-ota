// Entry module of the not-found page (404.html, ota/frontend/docs/pages-account.md §8): Caddy serves it for unknown
// paths, and boot() brands its header and footer like every other page. Its content is static.
import { boot } from "../boot.js";

document.documentElement.dataset.js = "on";
boot();
