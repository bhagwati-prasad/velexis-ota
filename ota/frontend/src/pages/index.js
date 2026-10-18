// Entry module of the home page (index.html), its only script (conventions §4). Pages are meaningful without
// JavaScript; this module marks the document as enhanced, so styles can tell the two apart, and runs the shared
// start-up (src/boot.js: configuration, theme, header, footer, test banner, session). The search form (OFE-004) joins
// it here with what boot() resolves with.
import { boot } from "../boot.js";

document.documentElement.dataset.js = "on";
boot();
