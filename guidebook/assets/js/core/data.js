/* Velexis Guidebook: access to the content bundle (window.VG_CONTENT, written by tools/build.mjs). */
(function () {
  "use strict";
  const VG = window.VG;

  const EMPTY = {
    site: { title: "Velexis Guidebook", tagline: "", repoBase: "", apps: [] },
    pages: [],
    apps: [],
    diagrams: {},
    journeys: [],
    terms: [],
    issues: [],
    taxonomy: null,
    ontology: { classes: [], properties: [], individuals: [], assertions: [] },
    relations: [],
    topology: null,
    graph: { nodes: [], edges: [] },
    search: [],
    stats: {},
  };

  const byId = (list) => new Map((list || []).map((x) => [x.id, x]));

  const D = {
    loaded: false,
    init(content) {
      const c = Object.assign({}, EMPTY, content || {});
      c.ontology = Object.assign({}, EMPTY.ontology, c.ontology || {});
      c.graph = c.graph || EMPTY.graph;
      this.c = c;
      this.loaded = Boolean(content);
      this.site = c.site || EMPTY.site;
      this.aliases = (this.site && this.site.appAliases) || {};
      this.pages = byId(c.pages);
      this.apps = byId(c.apps);
      this.journeys = byId(c.journeys);
      this.terms = byId(c.terms);
      this.issues = byId(c.issues);
      this.classes = byId(c.ontology.classes);
      this.properties = byId(c.ontology.properties);
      this.individuals = byId(c.ontology.individuals);
      this.graphNodes = byId(c.graph.nodes);
      // terms sorted for display (A-Z by visible term)
      this.termList = (c.terms || [])
        .slice()
        .sort((a, b) =>
          String(a.term || a.id).localeCompare(String(b.term || b.id), "en", { sensitivity: "base" }),
        );
      // aliases -> term id (lower case), for the search and hover cards
      this.termByAlias = new Map();
      for (const t of c.terms || []) {
        for (const a of [t.term, ...(t.aliases || [])]) {
          if (a && !this.termByAlias.has(String(a).toLowerCase()))
            this.termByAlias.set(String(a).toLowerCase(), t.id);
        }
      }
      return this;
    },
    resolveApp(id) {
      return id && this.aliases[id] ? this.aliases[id] : id;
    },
    app(id) {
      return this.apps.get(this.resolveApp(id));
    },
    appName(id) {
      const a = this.app(id);
      return a ? a.name || a.id : id;
    },
    appList() {
      return this.c.apps || [];
    },
    /** Groups of apps for the sidebar (site.json appGroups, else one group per product). */
    appGroups() {
      const apps = this.appList();
      const groups = Array.isArray(this.site.appGroups) ? this.site.appGroups : null;
      if (groups && groups.length) {
        const seen = new Set();
        const out = groups
          .map((g) => ({
            label: g.label,
            apps: (g.apps || [])
              .map((id) => this.app(id))
              .filter((a) => a && !seen.has(a.id) && seen.add(a.id)),
          }))
          .filter((g) => g.apps.length);
        const rest = apps.filter((a) => !seen.has(a.id));
        if (rest.length) out.push({ label: "Other", apps: rest });
        return out;
      }
      const byProduct = new Map();
      for (const a of apps) {
        const key = a.product || "other";
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push(a);
      }
      return [...byProduct].map(([k, list]) => ({ label: k[0].toUpperCase() + k.slice(1), apps: list }));
    },
    diagram(key, ctxApp) {
      if (!key) return null;
      const k = key.includes("/") ? key : ctxApp ? `${ctxApp}/${key}` : key;
      const [a, ...rest] = k.split("/");
      return this.c.diagrams[k] || this.c.diagrams[`${this.resolveApp(a)}/${rest.join("/")}`] || null;
    },
    diagramList() {
      return Object.values(this.c.diagrams || {});
    },
    pageList() {
      return this.c.pages || [];
    },
    journeyList() {
      return this.c.journeys || [];
    },
    /** Known issues in id order (KI-001, KI-002, …). */
    issueList() {
      return this.c.issues || [];
    },
    /** Known issues of an app (aliases resolved), or of a journey (and one of its steps). */
    issuesOf(filter) {
      const f = filter || {};
      const app = f.app ? this.resolveApp(f.app) : null;
      return this.issueList().filter(
        (x) =>
          (!app || this.resolveApp(x.app) === app) &&
          (!f.journey || x.journey === f.journey) &&
          (!f.step || x.step === f.step),
      );
    },
    /** Glossary terms whose ontology class is `classId`. */
    termsOfClass(classId) {
      return (this.c.terms || []).filter((t) => t.classOf === classId);
    },
    repoUrl(path) {
      const base = this.site.repoBase || "";
      const clean = String(path || "")
        .trim()
        .replace(/^\.?\//, "");
      return base ? base + clean : clean;
    },
    nodeRoute(nodeId) {
      const n = this.graphNodes.get(nodeId);
      return n ? n.route : null;
    },
  };
  VG.data = D;
})();
