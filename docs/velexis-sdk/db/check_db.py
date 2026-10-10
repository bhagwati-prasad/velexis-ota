#!/usr/bin/env python3
"""Validate the multi-tenant database design by running it on a real PostgreSQL 16 and cross-checking the ER diagrams.

Inputs (in this directory): platform.sql, reference.sql, tenant.sql, er/er-platform.mmd, er/er-reference.mmd, er/er-tenant.mmd,
er/er-overview.mmd, dictionary.json.  Output: er/*.svg (rendered diagrams), introspection.json.
Usage: python3 -I check_db.py
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.dirname(HERE)
SCRATCH = os.path.dirname(WORK)
PSQL = ["psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-X"]
DB = "velexis_check"
BRIEF_TENANT = set("""customers customer_identities customer_sessions customer_password_resets saved_travelers saved_traveler_documents customer_preferences
flight_searches flight_offers offer_upsells priced_offers checkouts checkout_travelers checkout_contacts checkout_ancillaries payments payment_events refunds
bookings booking_travelers booking_contacts booking_segments booking_ancillaries booking_remarks booking_tickets booking_documents booking_events
booking_access_tokens supplier_requests markup_rules fee_rules notification_templates notifications staff_actions queue_snapshots storefront_settings idempotency_keys""".split())
BRIEF_PLATFORM = set("""accounts account_sessions tenants tenant_domains tenant_memberships tenant_invitations plans subscriptions invoices api_keys supplier_connections
payment_provider_connections tenant_schema_migrations provisioning_jobs platform_audit_log""".split())
BRIEF_REFERENCE = set("countries currencies time_zones cities airports airlines aircraft".split())
TENANTS = ["tenant_acme", "tenant_globex"]


def sql(cmd, db=DB, input_file=None, extra=()):
    args = PSQL + ["-d", db] + list(extra)
    if input_file:
        args += ["-f", input_file]
    else:
        args += ["-c", cmd]
    r = subprocess.run(args, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def q(query):
    r = subprocess.run(PSQL + ["-d", DB, "-At", "-F", "\t", "-c", query], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)
    return [l.split("\t") for l in r.stdout.strip().splitlines() if l]


def parse_mermaid(text):
    ents, rels = {}, []
    cur = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("%%") or line.startswith("erDiagram") or line.startswith("---") or line.startswith("title"):
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*(\[[^\]]*\])?\s*\{$', line)
        if m:
            cur = m.group(1)
            ents.setdefault(cur, [])
            continue
        if line == "}":
            cur = None
            continue
        if cur:
            parts = line.split()
            if len(parts) >= 2:
                ents[cur].append(parts[1])
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s+([|}o][|o]?--[|o]?[|{o]|[|}o][|o]?\.\.[|o]?[|{o])\s+([A-Za-z_][A-Za-z0-9_]*)\s*:', line)
        if m:
            rels.append((m.group(1), m.group(3)))
    return ents, rels


def render(files, errs):
    js = os.path.join(SCRATCH, "oatools", "node_modules", "mermaid", "dist", "mermaid.min.js")
    script = os.path.join(HERE, ".render.js")
    open(script, "w").write("""
const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent('<html><body></body></html>');
  await p.addScriptTag({ path: process.argv[2] });
  await p.evaluate(() => mermaid.initialize({ startOnLoad: false, er: { useMaxWidth: false }, maxTextSize: 2000000, securityLevel: 'strict' }));
  for (const f of process.argv.slice(3)) {
    const src = fs.readFileSync(f, 'utf8');
    try {
      const { svg } = await p.evaluate(async (s) => mermaid.render('d' + Math.floor(Math.random()*1e9), s), src);
      fs.writeFileSync(f.replace(/\\.mmd$/, '.svg'), svg);
      console.log('OK ' + f);
    } catch (e) { console.log('FAIL ' + f + ' :: ' + String(e && e.message || e).slice(0, 400)); }
  }
  await b.close();
})();
""")
    env = dict(os.environ)
    gr = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
    env["NODE_PATH"] = gr
    r = subprocess.run(["node", script, js] + files, capture_output=True, text=True, env=env, timeout=600)
    for line in (r.stdout + r.stderr).splitlines():
        if line.startswith("FAIL") or "Error" in line:
            errs.append("mermaid render: " + line.replace(HERE + "/", ""))
    os.remove(script)


PGDATA = "/var/lib/postgresql/vx/data"
PGCTL = "/usr/lib/postgresql/16/bin/pg_ctl"


def pg_up():
    return subprocess.run(PSQL + ["-d", "postgres", "-Atc", "select 1"], capture_output=True).returncode == 0


def pg_start():
    """Start a short-lived local PostgreSQL 16 for this check (stopped again when the check ends)."""
    if pg_up():
        return False
    pid = os.path.join(PGDATA, "postmaster.pid")
    if os.path.exists(pid):
        os.remove(pid)
    subprocess.run(["su", "postgres", "-s", "/bin/bash", "-c", f"{PGCTL} -D {PGDATA} -o '-p 5433 -k /tmp' -l /var/lib/postgresql/vx/log.txt -w start"], capture_output=True)
    return pg_up()


def pg_stop():
    subprocess.run(["su", "postgres", "-s", "/bin/bash", "-c", f"{PGCTL} -D {PGDATA} -m fast -w stop"], capture_output=True)


def main():
    started = pg_start()
    if not pg_up():
        print("ERRORS: 1\n  - could not start the local PostgreSQL 16 server")
        return 1
    try:
        return run_checks()
    finally:
        if started:
            pg_stop()


def run_checks():
    errs, warns = [], []
    need = ["platform.sql", "reference.sql", "tenant.sql", "dictionary.json", "er/er-platform.mmd", "er/er-reference.mmd", "er/er-tenant.mmd", "er/er-overview.mmd"]
    for f in need:
        if not os.path.exists(os.path.join(HERE, f)):
            errs.append(f"missing {f}")
    if errs:
        print("ERRORS:", len(errs)); [print("  - " + e) for e in errs]
        return 1
    tsql = open(os.path.join(HERE, "tenant.sql")).read()
    body = re.sub(r"--[^\n]*", "", tsql)
    for bad in (r"\bplatform\.", r"\btenant_[a-z0-9_]+\.", r"\bpublic\.", r"\breference\.\w+\s*\("):
        if re.search(bad, body, re.I):
            errs.append(f"tenant.sql must not reference other schemas by qualified name (found /{bad}/); tenant tables use unqualified names and no cross-schema FKs")
    if re.search(r"\bsearch_path\b|\bCREATE\s+SCHEMA\b", body, re.I):
        errs.append("tenant.sql must not set search_path or create schemas (the provisioner does that)")
    subprocess.run(PSQL + ["-d", "postgres", "-c", f"DROP DATABASE IF EXISTS {DB}"], capture_output=True)
    subprocess.run(PSQL + ["-d", "postgres", "-c", f"CREATE DATABASE {DB}"], capture_output=True)
    for f in ("platform.sql", "reference.sql"):
        rc, out = sql(None, input_file=os.path.join(HERE, f))
        if rc != 0:
            errs.append(f"{f} failed: {out[-1500:]}")
    for t in TENANTS:
        wrapper = os.path.join(HERE, f".prov-{t}.sql")
        open(wrapper, "w").write(f"BEGIN;\nCREATE SCHEMA {t};\nSET LOCAL search_path TO {t}, reference;\n\\i {os.path.join(HERE, 'tenant.sql')}\nCOMMIT;\n")
        rc, out = sql(None, input_file=wrapper)
        os.remove(wrapper)
        if rc != 0:
            errs.append(f"tenant.sql failed in {t}: {out[-1500:]}")
    if errs:
        print("ERRORS:", len(errs)); [print("  - " + e) for e in errs]
        return 1
    cols = q("""select table_schema, table_name, column_name, data_type, is_nullable from information_schema.columns
                where table_schema in ('platform','reference','tenant_acme','tenant_globex') order by table_schema, table_name, ordinal_position""")
    tables = {}
    for s, t, c, dt, nl in cols:
        tables.setdefault((s, t), []).append((c, dt, nl))
    fks = q("""select n1.nspname, c1.relname, n2.nspname, c2.relname, con.conname from pg_constraint con
               join pg_class c1 on c1.oid = con.conrelid join pg_namespace n1 on n1.oid = c1.relnamespace
               join pg_class c2 on c2.oid = con.confrelid join pg_namespace n2 on n2.oid = c2.relnamespace where con.contype = 'f'""")
    by_schema = {}
    for (s, t) in tables:
        by_schema.setdefault(s, set()).add(t)
    if by_schema.get("tenant_acme") != by_schema.get("tenant_globex"):
        errs.append("tenant schemas differ after provisioning")
    for s1, t1, s2, t2, name in fks:
        if s1 != s2:
            errs.append(f"cross-schema FK {name}: {s1}.{t1} -> {s2}.{t2}")
    tset = by_schema.get("tenant_acme", set())
    for t in sorted(BRIEF_TENANT - tset):
        errs.append(f"tenant table from the brief is missing: {t}")
    for t in sorted(BRIEF_PLATFORM - by_schema.get("platform", set())):
        errs.append(f"platform table from the brief is missing: {t}")
    for t in sorted(BRIEF_REFERENCE - by_schema.get("reference", set())):
        errs.append(f"reference table from the brief is missing: {t}")
    for t in sorted(tset):
        cn = {c for c, _, _ in tables[("tenant_acme", t)]}
        for need_c in ("id", "created_at"):
            if need_c not in cn:
                errs.append(f"tenant table {t} lacks column {need_c}")
        if "updated_at" not in cn and not any(x in t for x in ("events", "requests", "staff_actions", "snapshots", "log")):
            warns.append(f"tenant table {t} has no updated_at (fine only for append-only tables)")
    pk = q("""select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
              and n.nspname in ('platform','reference','tenant_acme') and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p')""")
    for s, t in pk:
        errs.append(f"table {s}.{t} has no primary key")
    # diagrams
    dic = json.load(open(os.path.join(HERE, "dictionary.json")))
    schema_of_file = {"er/er-platform.mmd": "platform", "er/er-reference.mmd": "reference", "er/er-tenant.mmd": "tenant_acme"}
    fk_pairs = {}
    for s1, t1, s2, t2, _ in fks:
        fk_pairs.setdefault(s1, set()).add(frozenset((t1, t2)))
    for f, s in schema_of_file.items():
        ents, rels = parse_mermaid(open(os.path.join(HERE, f)).read())
        real = by_schema.get(s, set())
        for t in sorted(real - set(ents)):
            errs.append(f"{f}: table {t} is missing from the diagram")
        for e in sorted(set(ents) - real):
            errs.append(f"{f}: entity {e} is not a table of schema {s}")
        for e, attrs in ents.items():
            if e in real:
                cn = {c for c, _, _ in tables[(s, e)]}
                for a in attrs:
                    if a not in cn:
                        errs.append(f"{f}: {e}.{a} is not a column")
        relset = {frozenset(r) for r in rels}
        for pair in fk_pairs.get(s, set()):
            if pair not in relset and len(pair) == 2:
                errs.append(f"{f}: FK between {' and '.join(sorted(pair))} has no relationship line")
        for r in relset:
            if r not in fk_pairs.get(s, set()) and len(r) == 2:
                warns.append(f"{f}: relationship {' - '.join(sorted(r))} has no FK (value reference only?)")
    # dictionary coverage
    for (s, t), cl in tables.items():
        if s == "tenant_globex":
            continue
        key = f"{'tenant' if s.startswith('tenant_') else s}.{t}"
        ent = dic.get(key)
        if not ent or not str(ent.get("description", "")).strip():
            errs.append(f"dictionary.json: {key} needs a description")
            continue
        for c, _, _ in cl:
            if not str(ent.get("columns", {}).get(c, "")).strip():
                errs.append(f"dictionary.json: {key}.{c} needs a description")
    render([os.path.join(HERE, x) for x in ("er/er-overview.mmd", "er/er-platform.mmd", "er/er-reference.mmd", "er/er-tenant.mmd")], errs)
    intro = {"schemas": {s: sorted(v) for s, v in by_schema.items()}, "fks": len(fks),
             "columns": {f"{s}.{t}": [{"name": c, "type": dt, "nullable": nl == "YES"} for c, dt, nl in cl] for (s, t), cl in tables.items() if s != "tenant_globex"}}
    json.dump(intro, open(os.path.join(HERE, "introspection.json"), "w"), indent=1)
    print(f"platform tables: {len(by_schema.get('platform', ()))}  reference: {len(by_schema.get('reference', ()))}  tenant: {len(tset)}  FKs: {len(fks)}")
    print(f"ERRORS: {len(errs)}")
    for e in errs[:100]:
        print("  - " + e)
    print(f"WARNINGS: {len(warns)}")
    for w in warns[:40]:
        print("  - " + w)
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
