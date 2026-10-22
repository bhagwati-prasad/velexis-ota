# Fonts of the booking documents

The itinerary and e-ticket receipt PDFs (OBE-053, [OADR-0013](../../../../docs/adr/0013-notifications-and-booking-documents.md) item 7, [ADR-0017](../../../../../docs/mvp/adr/0017-email-documents-storage.md)) embed these fonts, bundled in the repository so the worker never fetches one. The renderers (`../renderers/itinerary.renderer.ts`) read them once, on the first render, and pdfmake embeds the subset of glyphs each document uses. The build copies this folder to `dist/documents/fonts/` (`package.json`'s `build` script), so a release ships them next to the compiled code.

| File | Font | Licence | SHA-256 |
|---|---|---|---|
| `Roboto-Regular.ttf` | Roboto Regular, version 3.014 | SIL Open Font License 1.1 | `ab9c18a75da1636435afd2398ffce325496644a8f258f918c92c4baf34a68625` |
| `Roboto-Medium.ttf` | Roboto Medium, version 3.014 (the documents' bold) | SIL Open Font License 1.1 | `4cb9d8a346d7d9190ef145daad9a85d58e2592043b199cdb8ed52ff535c64047` |
| `OFL.txt` | The licence text with the Roboto copyright notice | — | `061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41` |

- **Source.** The two font files are byte copies of `Roboto-Regular.ttf` and `Roboto-Medium.ttf` in `build/vfs_fonts.js` of `pdfmake@0.2.23` (the npm package's default fonts, base64), decoded unchanged. Their `name` tables say: "Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic)", designer Christian Robertson, "licensed under the SIL Open Font License, Version 1.1". `OFL.txt` is the `OFL.txt` of [googlefonts/roboto-classic](https://github.com/googlefonts/roboto-classic) (branch `main`), unchanged.
- **Licence.** The SIL Open Font License 1.1 allows bundling, embedding and redistributing the fonts with software, as long as the fonts are not sold by themselves and the copyright notice and licence go with them: `OFL.txt` is kept here and copied with the fonts.
- **Italics.** The documents use no italic text; pdfmake's `italics` and `bolditalics` variants map to the regular and medium files.
- **Coverage.** Roboto covers Latin (with the accented letters of Western and Central European languages), Greek and Cyrillic. Amadeus names are upper-case Latin letters, so every traveller name renders; a character outside the fonts prints as an empty box, never as a failure.
- **Changing a font.** Replace the file, update the table above, and update the checksums `../renderers/renderers.test.ts` pins (a font change changes every document's bytes, so the next render of each booking stores a new document version).
