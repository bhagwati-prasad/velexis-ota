# Velexis Guidebook

A static, interactive HTML guide to every Velexis application: a **usage guide** and an **architecture guide** per
app, cross-app **journeys** with a bug-hunting checklist, the **known issues** (verified bugs to fix, filterable, as a
Markdown checklist or JSON), a **glossary**, a **taxonomy**, a **knowledge graph** (2D and 3D), an **ontology** and a
**3D system view** with animated request flows.

It is written for the owner walking through the apps to find bugs: every page says what a thing is, how to use it,
what should happen, where the code is and which tables change.

- No build step for the site code, no framework, no server needed: open `index.html`.
- Content (Markdown and JSON in `content/`) is separate from code (`assets/`); adding an app is adding a folder.
- `tools/build.mjs` (zero dependencies) validates every cross reference and writes `dist/content.js`. The tools run on
  Node.js 24, the major in the repository's `.nvmrc`.
- [`SCHEMA.md`](SCHEMA.md) is the contract for content and code: every file and field, the Markdown dialect, the diagram
  formats and the code rules.

## Open it

| How | Command | Notes |
|---|---|---|
| From disk | double-click `guidebook/index.html` | Works from `file://`. Needs network access to `cdn.jsdelivr.net` for d3, marked, DOMPurify and three.js. |
| Local server | `node guidebook/tools/serve.mjs` then open http://127.0.0.1:4173 | Optional; `--port 0` picks a free port, `--host` and `--root` are available. Local only by default. |

The vendor libraries load from `cdn.jsdelivr.net` with pinned versions and Subresource Integrity (d3 7.9.0, marked
15.0.12, DOMPurify 3.2.6, and three.js 0.170.0 on demand; see [Code](#code-how-the-site-is-built)), so diagrams,
formatting and the 3D views need the network. If a library cannot be loaded (offline), the page shows a banner and
still shows all text; diagrams fall back to text lists and 3D views to the 2D map. If `dist/content.js` is missing, a
banner says how to build it.

Keyboard: **Ctrl+K** / **Cmd+K** (or `/`) opens the search palette; arrow keys step through sequence diagrams and flow
steppers; Escape closes popovers, the palette and the drawer. The theme button cycles system, light and dark (saved in
`localStorage`); the link button copies a link to the current view (every view, selection and filter that matters is
in the URL hash).

## Folder map

```
guidebook/
  index.html                 shell: vendor libraries (CDN, pinned, SRI), styles, scripts, content bundle loader
  README.md                  this file
  SCHEMA.md                  the content and code contract (files, fields, dialect, diagram formats, code rules)
  assets/css/guide.css       all styles; CSS custom properties; light + dark; responsive to 360 px; print styles
  assets/js/core/            classic scripts sharing one global, window.VG
    text.js                  slugs and plain-text helpers (also evaluated by tools/build.mjs: identical heading ids)
    vg.js                    DOM builder, storage, events, clipboard, colours, icons, route helpers
    data.js                  access to window.VG_CONTENT (lookups, app aliases, repo links)
    ui.js                    banners, toasts, popovers, term hover cards, chips, filterable tables, fullscreen
    markdown.js              marked + DOMPurify with the guidebook extensions (see "Markdown dialect")
    widgets.js               diagram registry, figure frame (title, toolbar, fullscreen, caption), SVG helpers
    three.js                 lazy loader for three.js (import map + dynamic import)
    search.js                search over the build's index and the Ctrl/Cmd+K palette
    layout.js                top bar, sidebar drawer, breadcrumbs, table of contents with scroll-spy, theme
    router.js                hash router (#/view/arg?param=value) and the view registry
    boot.js                  start-up: waits for the bundle, checks libraries, builds the shell, starts the router
  assets/js/views/           one file per view: home, page, app, diagram, journeys, issues, glossary, taxonomy,
                             graph, ontology, system, search
  assets/js/widgets/         one file per diagram type: component, sequence, state, er, flow, tree
  content/                   the guide itself (see "Content")
  dist/content.js            GENERATED: window.VG_CONTENT = {...}; committed so file:// works
  tools/build.mjs            validate content and write dist/content.js
  tools/serve.mjs            optional static server
  tools/guidebook.test.mjs   node:test suite
  tools/fixtures/content/    small but complete sample content used by the tests (every diagram type)
```

## Routes

| Route | View |
|---|---|
| `#/` | Home: summary, system map (from `content/system/topology.json` + app links), counts, cards |
| `#/page/<id>?s=<section>` | A page from `content/pages/` (the `s` parameter scrolls to a section) |
| `#/app/<id>/usage`, `/architecture`, `/facts` | App guide tabs; facts renders `app.json` (`?screen=` / `?endpoint=` pre-filter the tables) |
| `#/diagram`, `#/diagram/<app>/<id>` | All diagrams; one diagram full width with "used in" |
| `#/journeys?app=<id>`, `#/journey/<id>?step=<step>` | Journey list (filter by app); checklist with Pass / Bug / Skip, notes, progress, bug report; `step` scrolls to a step; a step with known issues shows a badge |
| `#/issues?app=&severity=&kind=&status=&q=&journey=&step=&sort=&open=` | Known issues: chips with counts per severity, kind, status and app (comma-separated values in the URL), text filter, sortable columns (`sort=title`, `sort=-severity`), rows that expand to the full record (`open=KI-001,KI-004`), "Copy as Markdown" (the filtered list as a checklist) and "Download JSON" |
| `#/issue/<id>` | One known issue, full width: steps, expected and actual, fix, evidence and files with repo links, journey step, terms, "Copy as Markdown" |
| `#/glossary`, `#/glossary/<term>` | A-Z index, instant search, category and app filters, term detail with neighbourhood graph and backlinks |
| `#/taxonomy?view=tree\|sunburst` | Collapsible tree or zoomable sunburst; terms open their glossary entry |
| `#/graph?focus=<kind:id>&depth=1\|2&mode=3d` | Knowledge graph: kind chips (Issue starts off, Individual too in a large graph), filters, search-to-focus, 1-2 hop neighbourhoods, 3D |
| `#/ontology`, `#/ontology/<Class>?individual=<id>` | Class hierarchy (tree / radial), property diagram, tables |
| `#/system?flow=<id>&node=<id>` | System 3D: layers, nodes, links, animated flows (play / pause / step) |
| `#/search?q=<text>` | All search results, filterable by kind |

## Keeping the guidebook current

The guidebook describes the code at the commit named in `content/site.json`, and keeping it true is part of the
definition of done ([`AGENTS.md`](../AGENTS.md) §5; lead decision (35d) of 2026-11-20, approved by the owner):

- A change to a screen, endpoint, table, flow or term also updates `guidebook/content/` and rebuilds the bundle
  (`node guidebook/tools/build.mjs --strict`), in the same change; commit the content and `dist/content.js` together.
- A fixed known issue updates or removes its entry in `content/issues/issues.json` (removed ids are never reused; see
  [Known issues: add, edit, remove](#known-issues-add-edit-remove)).

CI checks it (lead decision (35e) of 2026-11-20, approved by the owner): the `build-test` job's step "Lint and test the
CI checks, tools/perf and the guidebook" in `.github/workflows/ci.yml` runs `pnpm exec eslint guidebook` and
`node --test guidebook/tools/guidebook.test.mjs`, so a stale `dist/content.js`, a broken reference, a repo path that
no longer exists or an issue's line past the end of its file turns CI red. Run both before you commit (see
[Testing](#testing)).

## Update the content

1. Edit a file under `guidebook/content/` (Markdown or JSON).
2. Run `node guidebook/tools/build.mjs`. It prints every problem with its file (and line for Markdown) and refuses to
   write the bundle while there are errors (`--force` writes anyway; the exit code is still 1).
3. Reload the page. Commit the content change **and** `dist/content.js` together.

Known issues live in `content/issues/issues.json`: add one with the next free `KI-` id, update its `where` lines when
the code moves, and delete it when it is fixed (ids are never reused). See
[Known issues: add, edit, remove](#known-issues-add-edit-remove) for the fields and the checks.

Builder options: `--content <dir>`, `--out <file>`, `--check` (fail if the existing output differs: use it in CI),
`--strict` (warnings fail too), `--repo <dir>|none` (repository root used to check every repo path; by default the
parent of the guidebook folder, else its grandparent, whichever holds `pnpm-workspace.yaml`; a `--repo` folder without
that file is an error; without a root the paths are not checked and one warning says so), `--quiet`.

The output is deterministic (stable ordering, no timestamps). The repository's `.prettierignore` skips
`guidebook/dist/` (the builder's `--check` and the test compare it byte for byte with the content), and the file's
first line is `// prettier-ignore` as well. The repository's `.gitignore` re-includes `guidebook/dist/`: the bundle is
a source, because the site opens from `file://`.

### What the builder checks

Errors: front matter missing or invalid; duplicate ids (pages, terms, journeys, journey steps, diagram nodes, classes,
properties, individuals, topology nodes/layers/flows, taxonomy nodes); unknown `[[term]]`, `[[app:]]`, `[[page:]]`,
`[[journey:]]`, `[[diagram:]]` links and `diagram` blocks; unknown internal `#/...` links; related terms, taxonomy
terms, `classOf`, term apps that do not exist; ontology parent, domain, range, individual class, assertion subject,
property and object that do not exist, class hierarchy cycles; app `id` not equal to its folder, unknown apps in
`dependsOn` / `talksTo` / journeys / diagram nodes / topology; diagram edges, steps, transitions and relations that
point at unknown ids; unknown diagram types; topology links and flow hops through unknown nodes; graph relations that
do not resolve; invalid JSON; unclosed code fences; `repo:` paths that do not exist (when the repository is present);
known issues with a missing or duplicate id (also across files), an id that is not `KI-<number>`, a severity, kind or
status outside its list, a `migration` that is not true or false, a missing field, an unknown app, journey, step or
term, a `files` entry with a line number, a `where` line outside its file, or a new file whose folder does not exist.

Warnings: missing summaries and captions, unknown kinds, terms not placed in the taxonomy, apps missing from
`site.json`, unknown `try` keys, ids that do not follow the naming convention, unknown issue fields, an issue's new
file that exists now.

### What the builder computes

Backlinks (which documents and known issues mention each term), "used in" for each diagram, the search index (pages,
sections, terms, apps, screens, endpoints, journeys, known issues, diagrams, classes), the knowledge graph and
statistics. `data.stats` holds the count of every content kind, the issue counts by severity, kind, status and app
(`issuesBySeverity`, `issuesByKind`, `issuesByStatus`, `issuesByApp`), `graphNodes`, `graphEdges`, `words`,
`searchEntries` and `repoPaths` (repo paths found in the content). `repoPaths` is the same with or without `--repo`, so
the bundle does not depend on where the repository is; whether the paths were checked is only printed.

The knowledge graph has nodes `app:`, `term:`, `class:`, `individual:`, `journey:`, `issue:` (and `page:` when a
relation names one) and edges from: app `dependsOn` ("depends on") and `talksTo` ("talks to"); term `apps` ("used in"), `related`
("related to") and `classOf` ("is a"); class `parent` ("subclass of"); property domain to range (the property label);
individual class ("instance of"), app ("belongs to") and term ("described by"); assertions (property label); journey
apps ("covers"); issue app ("affects"), journey ("seen in") and terms ("about"); and the extra triples in
`content/graph/*.json`. The graph view starts with the Issue chip off and, in a graph of more than 600 nodes (the real
content has over 1,100), with the Individual chip off too: both are a click away, and `#/graph?focus=issue:<id>` or
`focus=individual:<id>` turns that kind on.

## Content

```
content/site.json                        title, tagline, repoBase, commit, date, app order, app groups, app aliases
content/pages/*.md                       system pages (front matter "order" sets the sidebar order)
content/apps/<appId>/app.json            facts card
content/apps/<appId>/usage.md            usage guide
content/apps/<appId>/architecture.md     architecture guide
content/apps/<appId>/diagrams/<id>.json  diagrams of that app
content/journeys/<id>.json               cross-app walkthroughs
content/glossary/*.json                  glossary terms (arrays; several files are merged)
content/taxonomy/taxonomy.json           taxonomy tree
content/ontology/*.json                  ontology (classes, properties, individuals, assertions; files are merged)
content/graph/*.json                     extra knowledge-graph triples
content/issues/*.json                    known issues (arrays; several files are merged)
content/system/topology.json             layers, nodes, links and flows for the home map and System 3D
```

App ids (folder names): `portal`, `platform-admin`, `platform-api`, `storefront`, `ota-admin`, `ota-api`, `sdk`,
`packages` (also covers `tools/*`; `site.json` maps the alias `tools` to `packages`) and `deploy`.

Rules: accurate to the code (code beats docs; say so when they disagree); no secrets (development seed passwords that
are already committed may be quoted, marked "development only"); placeholder hosts only (`*.example.com`, `localhost`).

### Add an app

Create `content/apps/<appId>/` with `app.json`, `usage.md`, `architecture.md` and optionally `diagrams/*.json`, add the
id to `apps` (and an `appGroups` entry) in `content/site.json`, and build. The sidebar, home cards, search, graph and
facts tab pick it up automatically.

`app.json`:

```json
{
  "id": "portal",
  "name": "Portal",
  "kind": "frontend | backend | worker | library | tooling | infrastructure",
  "product": "platform | ota | shared",
  "summary": "One sentence.",
  "audience": ["OTA owner"],
  "repoPath": "platform/frontend",
  "package": "@velexis/platform-frontend",
  "stack": ["Next.js App Router", "React"],
  "local": { "url": "http://localhost:3000", "port": 3000, "command": "pnpm --filter … dev", "notes": "markdown" },
  "production": { "host": "platform.example.com" },
  "dependsOn": ["platform-api"],
  "talksTo": [{ "app": "platform-api", "how": "HTTPS, server side (BFF)" }],
  "data": ["platform.accounts"],
  "docs": ["platform/docs/architecture.md"],
  "adrs": ["docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md"],
  "roles": [{ "name": "OTA owner", "can": "…" }],
  "screens": [{ "route": "/sign-up", "title": "Sign up", "purpose": "…", "code": "platform/frontend/src/app/(auth)/sign-up/page.tsx" }],
  "endpoints": [{ "method": "POST", "path": "/v1/auth/sign-up", "operationId": "signUp", "tag": "auth", "purpose": "…" }],
  "tags": ["…"]
}
```

`usage.md` sections, in this order (skip what does not apply): What it is · Before you start · Tour · How to … · Roles
and permissions · Bug-hunting checklist · Troubleshooting.

`architecture.md` sections: At a glance · Components · Data · Key flows · Lifecycles · Integrations · Security ·
Configuration · Testing · Where to change things · Further reading.

### Add a page

Create `content/pages/<id>.md` with front matter (`id`, `title`, `summary`, `order`). It appears in the sidebar under
"Guide" in `order`, in search and in the home cards.

### Add a journey

`content/journeys/<id>.json` (the file name is the id):

```json
{
  "id": "sign-up-and-create-ota",
  "title": "Sign up and create an OTA",
  "summary": "markdown",
  "apps": ["portal", "platform-api"],
  "roles": ["OTA owner"],
  "duration": "15 min",
  "prerequisites": ["markdown"],
  "steps": [
    {
      "id": "open-sign-up",
      "app": "portal",
      "title": "Open the sign-up page",
      "url": "http://localhost:3000/sign-up",
      "actions": "markdown: what to do",
      "expect": "markdown: what should happen",
      "data": "markdown: tables, e-mails, queues to check",
      "code": ["platform/frontend/src/app/(auth)/sign-up/page.tsx"]
    }
  ]
}
```

The journey view keeps Pass / Bug / Skip and notes per step in `localStorage` (key `vg.journey.<id>`), shows progress,
and copies a Markdown bug report (journey, step, app, URL, guide link, date, code, steps to reproduce, expected, actual
(your notes or blank), data to check). With no step marked Bug, "Copy bug report" copies a template for the first open
step.

### Known issues: add, edit, remove

`content/issues/issues.json` is the owner's backlog of verified bugs (SCHEMA §14 has every field). Each entry:

```json
{
  "id": "KI-045",
  "title": "Short statement of the defect",
  "app": "portal",
  "severity": "low",
  "kind": "ux",
  "status": "confirmed",
  "where": ["platform/frontend/src/app/(app)/dashboard/page.tsx:56", "platform/frontend/src/lib/tenant.ts:76-83"],
  "summary": "markdown: what is wrong and why it matters",
  "reproduce": ["Step one.", "Step two."],
  "expected": "markdown",
  "actual": "markdown",
  "fix": "markdown",
  "files": ["platform/frontend/src/app/(app)/dashboard/page.tsx"],
  "migration": false,
  "journey": "signup-and-provision",
  "step": "provisioned",
  "terms": ["primary-host"]
}
```

Severity: `critical`, `high`, `medium`, `low`. Kind: `bug`, `db`, `security`, `ux`, `docs`, `perf`. Status:
`confirmed` (reproduced or proven from the code) or `plausible` (the code allows it; not reproduced yet). `newFiles`
lists files the fix creates.

- **Add**: append an object with the next free id (never reuse or renumber an id: tasks and links refer to it), then
  build with `--repo` so the paths and line numbers are checked: `node guidebook/tools/build.mjs --repo . --strict`.
- **Edit**: when the code moves, update the `where` lines (the build fails on a line past the end of its file). A
  plausible issue that you reproduced becomes `confirmed`; fill in what you saw as `actual`.
- **Fixed**: delete the object (its id stays retired) and rebuild. The fix's commit or task should name the id
  (`Fixes KI-007`). A build with the repository warns when a `newFiles` path exists, a hint that the issue is fixed.
- **Turn into tasks**: on `#/issues`, filter (for example `#/issues?app=portal&severity=high,medium`), then "Copy as
  Markdown" gives a checklist with summary, fix, files and a link per issue; "Copy as Markdown" on one issue gives a full
  task body. "Download JSON" saves the filtered records for scripts.

### Add a glossary term

Add an object to `content/glossary/terms.json` (or another JSON array in that folder):

```json
{
  "id": "tenant-schema",
  "term": "Tenant schema",
  "aliases": ["tenant_<key>"],
  "category": "tenancy",
  "definition": "markdown, 1-3 sentences",
  "apps": ["platform-api"],
  "related": ["schema-per-tenant"],
  "see": ["docs/mvp/adr/0004-postgresql-schema-per-tenant.md", "concepts"],
  "classOf": "Schema"
}
```

Ids are unique kebab-case. Categories: `product`, `travel`, `payments`, `identity`, `tenancy`, `data`, `api`,
`security`, `operations`, `engineering`, `process`. A `see` entry is a page id when such a page exists, otherwise a repo
path when it contains `/` or `.` (checked with the repository); anything else is an error. Place every term in at least
one taxonomy node.

### Taxonomy, ontology, relations

```json
{ "id": "velexis", "label": "Velexis", "children": [{ "id": "platform", "label": "Platform", "description": "…", "apps": ["portal"], "terms": ["tenant"], "children": [] }] }
```

```json
{
  "classes": [{ "id": "Tenant", "label": "Tenant", "parent": "Organisation", "description": "markdown", "examples": ["ten_…"] }],
  "properties": [{ "id": "ownsTenant", "label": "owns", "domain": "Account", "range": "Tenant", "cardinality": "0..n", "description": "…", "inverse": "ownedBy" }],
  "individuals": [{ "id": "demo-tenant", "label": "Demo OTA", "class": "Tenant", "app": "platform-api", "term": "tenant" }],
  "assertions": [{ "subject": "demo-owner", "property": "ownsTenant", "object": "demo-tenant" }]
}
```

Class ids PascalCase, property ids camelCase, individual ids kebab-case. Relations (`content/graph/*.json`):
`[{ "from": "class:Tenant", "to": "term:schema-per-tenant", "label": "explained by", "note": "optional" }]` with kinds
`app`, `term`, `class`, `individual`, `page`, `journey`, `issue`.

### Topology (home map and System 3D)

```json
{
  "layers": [{ "id": "people", "label": "People" }, { "id": "edge", "label": "Edge" }, { "id": "frontends", "label": "Frontends" }, { "id": "apis-workers", "label": "APIs and workers" }, { "id": "data", "label": "Data" }, { "id": "external", "label": "External services" }],
  "nodes": [{ "id": "portal", "label": "Portal", "layer": "frontends", "app": "portal", "kind": "ui", "detail": "markdown" }],
  "links": [{ "from": "caddy", "to": "portal", "label": "proxy", "kind": "sync" }],
  "flows": [{ "id": "sign-up", "title": "Sign up", "summary": "…", "path": [{ "from": "owner", "to": "caddy", "label": "POST /sign-up" }] }]
}
```

Node kinds: `user`, `edge`, `ui`, `api`, `worker`, `db`, `cache`, `queue`, `storage`, `external`. Link kinds: `sync`,
`async`, `data`. Layers are listed from outside (people) to inside (external services last).

## Markdown dialect

Every `.md` starts with front matter (`key: value` scalars and `key: [a, b]` lists only):

```
---
id: usage
title: Portal — usage guide
summary: One sentence shown in cards and search results.
order: 10
---
```

| Write | Renders |
|---|---|
| `[[tenant-schema]]`, `[[tenant-schema\|shown text]]` | Glossary link with a hover card |
| `[[app:portal]]`, `[[page:getting-started]]`, `[[journey:book-a-flight]]`, `[[diagram:portal/signup-flow]]` | Internal links (titles filled in) |
| `` `repo:platform/backend/src/auth/auth.controller.ts` `` (and `#L10`) | Link to the file at `repoBase` from `site.json` |
| `[text](repo:path)`, `[text](#/glossary/x)` | Same, as normal links (checked by the builder) |
| A ```` ```diagram ```` block whose body is `signup-flow` (this app) or `ota-api/booking-states` | The interactive diagram |
| ```` ```tip ````, ```` ```note ````, ```` ```warning ````, ```` ```bug-hunt ```` blocks (Markdown body) | Callouts |
| A ```` ```try ```` block with `url:`, `login:`, `password:`, `command:`, `expect:` lines | "Try it" card with copy buttons |
| `##` and `###` headings | Sections: anchors, table of contents, search entries |

Tables, lists, code blocks and links work as usual (GitHub-flavoured Markdown). A `|` inside `[[a|b]]` in a table row
is handled. Raw HTML is sanitised by DOMPurify.

## Diagram formats

`content/apps/<appId>/diagrams/<id>.json`; `id` is the file name. Common fields: `id`, `type`, `title`, `caption`
(Markdown). Ids of nodes, actors and entities are local to the diagram; `detail`, `note`, `body` and `expect` are
Markdown shown on click or in the stepper.

| Type | Fields | Interaction |
|---|---|---|
| `component` | `groups: [{id,label}]`, `nodes: [{id,label,group,kind,detail,app?,term?}]` (kind: `ui api worker db cache queue external lib user edge`), `edges: [{from,to,label,kind}]` (kind: `sync async data`) | Lanes per group, icons and colours per kind, curved labelled arrows, hover highlights neighbours, click for details (links to the app or term), zoom, pan, fit |
| `sequence` | `actors: [{id,label,kind}]`, `steps: [{from,to,label,kind,note?}]` (kind: `call return async self`) | Play / pause / next / previous / all, arrow keys, click a message to jump; the note panel shows the current message |
| `state` | `states: [{id,label,kind,detail?}]` (kind: `initial normal final error`), `transitions: [{from,to,label}]` | Layered layout; click a state to highlight where it can go next and see its detail |
| `er` | `entities: [{id,label,schema,fields:[{name,type,key?}]}]` (schema: `platform tenant reference redis`; key: `pk fk uk`), `relations: [{from,to,label,cardinality}]` (`1-1 1-n n-n`) | Schema colours, key badges, crow's-foot cardinality, tables packed in rows shaped like the box, drag tables, zoom, fit, click for relations |
| `flow` | `steps: [{title, actor?, screen?, url?, body, expect?}]` | Stepper with numbered dots, previous / next, arrow keys, copyable URL, expected result box |
| `tree` | `root: {name, children: [...], term?, detail?}` | Collapsible tidy tree, zoom, pan; nodes with `term` link to the glossary |

Every diagram has a title bar with zoom and fit buttons (where it applies), a fullscreen button, a caption and an
"Open" link to its own page. Wheel zoom needs Ctrl/Cmd so the page still scrolls; on touch screens two fingers pan and
zoom.

## Code: how the site is built

- Classic scripts only (no ES modules for local files), so the site works from `file://`. Everything hangs off
  `window.VG`. Vendor libraries are pinned with Subresource Integrity: d3 7.9.0, marked 15.0.12, DOMPurify 3.2.6;
  three.js 0.170.0 is loaded on demand through the import map in `index.html` (with integrity hashes) by
  `VG.three.load()`.
- HTML reaches the page only as DOMPurify's output (or escaped text when DOMPurify did not load): views put Markdown
  into an element with `VG.md.inlineInto(el, src)`, `VG.md.block(src)` or `VG.md.mount(container, src)`
  (`core/markdown.js`), and `VG.h` turns strings into text nodes, never HTML. ESLint enforces it with the storefront's
  HTML-sink rules (`eslint.config.mjs`, the guidebook blocks).
- `index.html` loads the content bundle before the site code runs. A test can pick another bundle with
  `index.html?bundle=<relative path>.js` (only relative `.js` paths are accepted) or by setting `window.VG_BUNDLE` or
  `window.VG_CONTENT` in an init script.
- A view: `VG.views.register(name, { title(route), wide?, render(main, route) -> { destroy?, update?(route) } })`
  (`wide` drops the table-of-contents column: home, diagram pages, known issues, graph, taxonomy, ontology, system);
  `update` returning `true` handles a parameter change in place (section scroll, glossary selection, graph focus).
  Add the first path segment to `VIEW_OF` in `router.js`.
- A diagram widget: `VG.widgets.register(type, { needsD3?, render(container, diagram, ctx) -> { fit?, zoomBy?, resize?, destroy? } })`.
  `ctx.detail(anchor, title, markdown, opts)` opens the detail popover. Add the type to `DIAGRAM_TYPES` and its checks
  to `validateDiagram` in `tools/build.mjs`.
- Colours are CSS custom properties (`--k-<kind>` for diagram kinds, `--g-<kind>` for graph kinds, `--cat-<category>`,
  `--s-<schema>`, `--p-<product>`); dark mode redefines them under `[data-theme="dark"]`. Canvas and WebGL read them
  with `VG.cssVar()` and redraw on the `theme` event.
- Accessibility: keyboard navigation and visible focus everywhere, labelled controls, SVG elements focusable with
  Enter/Space, `prefers-reduced-motion` honoured (no autoplay in System 3D, no tweens), AA contrast in both themes.
- Storage is optional: `localStorage` keys start with `vg.` (theme, journey progress); the site works without it.

## Testing

```
node --test guidebook/tools/guidebook.test.mjs
```

The suite builds the fixtures (no errors, byte-identical twice, every diagram type, the three fixture issues in the
bundle, stats, search index, graph and backlinks), detects every validation error kind on small broken copies
(including the known-issue checks, and line numbers against a small fake repository), checks `--check` (stale and
missing dist), `--strict`, `--force`, empty content, the real content and that `dist/content.js` is up to date, and the
static server (including path traversal). Outside the repository (a copy of the folder) the real-content tests are
skipped with a message while `content/apps` is empty or the bundle is not built, and the test that checks the
fixtures' repo paths against the real repository is skipped; in this repository nothing is skipped, and an empty
`content/apps` or a missing `dist/content.js` fails. CI runs the suite and `pnpm exec eslint guidebook` in
`build-test` (see [Keeping the guidebook current](#keeping-the-guidebook-current)).

Browser QA (not part of the suite): build the fixtures to a temporary file
(`node guidebook/tools/build.mjs --content guidebook/tools/fixtures/content --out <temporary folder>/content.js`), open
`index.html?bundle=<relative path to that file>#/` with Playwright, route `https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<path>`
to local copies of the packages when offline (answer with `access-control-allow-origin: *` so SRI and module loading
work), visit every route at 1280x800 and 390x844 and fail on console errors. For the known issues also check the
filters, an expanded row, `#/issue/<id>`, "Copy as Markdown", "Download JSON" (a Blob download, works from `file://`),
an app's "Known issues (N)" link, a journey step badge and the graph's Issue chip.

Formatting: `pnpm exec prettier --check guidebook` from the repository root (the repository's `.prettierignore` skips
Markdown and `guidebook/dist/`). Lint: `pnpm exec eslint guidebook` (classic browser scripts with the read-only
globals `d3`, `marked`, `DOMPurify` and `VG`, which only `core/text.js` and `core/vg.js` create; the tools are Node
scripts).
