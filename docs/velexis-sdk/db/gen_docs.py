#!/usr/bin/env python3
"""Generate dictionary.json and the per-schema Mermaid ER diagrams from the SQL files.

Column/table descriptions come from the SQL itself (single source of truth):
  * the comment block directly above `CREATE TABLE` is the table description;
  * the trailing `-- ...` comment of a column definition is the column description; a leading "* " marks the
    column as important (shown in the ER diagram besides PK/FK/UK columns).
Structure (columns, types, PK/FK/UK, nullability, ON DELETE) is introspected from a scratch database built
from platform.sql, reference.sql and one tenant schema provisioned from tenant.sql, so the diagrams always
match the real DDL.  Usage: python3 -I gen_docs.py
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PSQL = ["psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1"]
DB = "velexis_gen"
TENANT = "tenant_acme"
CONSTRAINT_WORDS = {"CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "EXCLUDE"}
TYPE_MAP = {"text": "text", "bpchar": "char", "varchar": "varchar", "int2": "smallint", "int4": "int", "int8": "bigint",
            "numeric": "numeric", "bool": "boolean", "timestamptz": "timestamptz", "timestamp": "timestamp", "date": "date",
            "jsonb": "jsonb", "bytea": "bytea", "inet": "inet", "_text": "text_array", "_int4": "int_array",
            "_int2": "smallint_array"}
DELETE_RULE = {"a": "no action", "r": "restrict", "c": "cascade", "n": "set null", "d": "set default"}
TITLES = {"platform": "Velexis control plane - schema platform (shared)",
          "reference": "Velexis reference data - schema reference (shared, read-only for tenants)",
          "tenant": "Velexis tenant schema - one copy per OTA (tenant_<key>)"}


def split_comment(line):
    in_q = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "'":
            in_q = not in_q
        elif not in_q and line.startswith("--", i):
            return line[:i], line[i + 2:].strip()
        i += 1
    return line, ""


def parse_sql(path):
    """Return {table: {"description": str, "columns": {col: (comment, important)}}} from the SQL comments."""
    tables, pending, cur, depth, at_start, col = {}, [], None, 0, True, None
    for raw in open(path, encoding="utf-8"):
        line = raw.rstrip("\n")
        if cur is None:
            m = re.match(r"^CREATE TABLE (?:\w+\.)?(\w+) \($", line)
            if m:
                cur = m.group(1)
                tables[cur] = {"description": " ".join(pending).strip(), "columns": {}}
                depth, at_start, col, pending = 0, True, None, []
            elif line.startswith("-- ") and not line.startswith("-- ="):
                pending.append(line[3:].strip())
            elif not line.startswith("--"):
                pending = []
            continue
        if line.strip() == ");":
            cur = None
            continue
        code, comment = split_comment(line)
        bare = re.sub(r"'(?:[^']|'')*'", "''", code)
        if code.strip() and at_start:
            tok = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)", code).group(1)
            col = None if tok.upper() in CONSTRAINT_WORDS else tok
            if col:
                tables[cur]["columns"][col] = ("", False)
        if comment and col:
            important = comment.startswith("* ")
            text = comment[2:] if important else comment
            prev, imp = tables[cur]["columns"][col]
            tables[cur]["columns"][col] = ((prev + " " + text).strip(), imp or important)
        if code.strip():
            depth += bare.count("(") - bare.count(")")
            at_start = depth == 0 and code.rstrip().endswith(",")
    return tables


def q(sql):
    r = subprocess.run(PSQL + ["-d", DB, "-At", "-F", "\t", "-c", sql], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return [l.split("\t") for l in r.stdout.splitlines() if l]


def build_db():
    subprocess.run(PSQL + ["-d", "postgres", "-c", f"DROP DATABASE IF EXISTS {DB}"], capture_output=True)
    subprocess.run(PSQL + ["-d", "postgres", "-c", f"CREATE DATABASE {DB}"], check=True, capture_output=True)
    for f in ("platform.sql", "reference.sql"):
        subprocess.run(PSQL + ["-d", DB, "-f", os.path.join(HERE, f)], check=True)
    wrapper = os.path.join(HERE, ".gen-prov.sql")
    open(wrapper, "w").write(f"BEGIN;\nCREATE SCHEMA {TENANT};\nSET LOCAL search_path TO {TENANT}, reference;\n"
                             f"\\i {os.path.join(HERE, 'tenant.sql')}\nCOMMIT;\n")
    try:
        subprocess.run(PSQL + ["-d", DB, "-f", wrapper], check=True)
    finally:
        os.remove(wrapper)


def introspect(schema):
    cols = {}
    for t, c, udt, nl in q(f"""select table_name, column_name, udt_name, is_nullable from information_schema.columns
                              where table_schema = '{schema}' order by table_name, ordinal_position"""):
        cols.setdefault(t, []).append({"name": c, "type": TYPE_MAP.get(udt, udt), "nullable": nl == "YES"})
    pk = {}
    for t, c in q(f"""select c.relname, a.attname from pg_constraint k join pg_class c on c.oid = k.conrelid
                     join pg_namespace n on n.oid = c.relnamespace join unnest(k.conkey) u(attnum) on true
                     join pg_attribute a on a.attrelid = c.oid and a.attnum = u.attnum
                     where k.contype = 'p' and n.nspname = '{schema}'"""):
        pk.setdefault(t, set()).add(c)
    uk = {}
    for t, defn in q(f"""select c.relname, pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid
                        join pg_namespace n on n.oid = c.relnamespace where n.nspname = '{schema}' and i.indisunique
                        and not i.indisprimary and i.indpred is null and i.indnatts = 1"""):
        m = re.search(r"USING btree \((?:lower\()?(\w+)\)?\)", defn)
        if m:
            uk.setdefault(t, set()).add(m.group(1))
    fks = []
    for child, cc, parent, pc, rule, conname in q(f"""
            select c1.relname, string_agg(a1.attname, ',' order by u.ord), c2.relname, string_agg(a2.attname, ',' order by u.ord),
                   k.confdeltype, k.conname
            from pg_constraint k join pg_class c1 on c1.oid = k.conrelid join pg_class c2 on c2.oid = k.confrelid
            join pg_namespace n on n.oid = c1.relnamespace
            join unnest(k.conkey, k.confkey) with ordinality u(ck, pk2, ord) on true
            join pg_attribute a1 on a1.attrelid = c1.oid and a1.attnum = u.ck
            join pg_attribute a2 on a2.attrelid = c2.oid and a2.attnum = u.pk2
            where k.contype = 'f' and n.nspname = '{schema}' group by c1.relname, c2.relname, k.confdeltype, k.conname
            order by c2.relname, c1.relname, k.conname"""):
        fks.append({"child": child, "cols": cc.split(","), "parent": parent, "parent_cols": pc.split(","),
                    "on_delete": DELETE_RULE[rule], "name": conname})
    return cols, pk, uk, fks


def mermaid_text(s, limit=95):
    s = re.sub(r"\s+", " ", s.replace('"', "'")).strip()
    return s if len(s) <= limit else s[:limit - 3].rstrip() + "..."


def write_er(key, schema, docs, cols, pk, uk, fks):
    fk_cols = {}
    for f in fks:
        for c in f["cols"]:
            fk_cols.setdefault(f["child"], set()).add(c)
    out = ["---", f"title: {TITLES[key]}", "---", "erDiagram"]
    for t in sorted(cols):
        out.append(f"  {t} {{")
        for c in cols[t]:
            n = c["name"]
            keys = [k for k, s in (("PK", pk), ("FK", fk_cols), ("UK", uk)) if n in s.get(t, set())]
            comment, important = docs.get(t, {}).get("columns", {}).get(n, ("", False))
            if not keys and not important:
                continue
            ks = (" " + ", ".join(keys)) if keys else ""
            out.append(f'    {c["type"]} {n}{ks} "{mermaid_text(comment)}"')
        out.append("  }")
    for f in fks:
        nullable = any(c["nullable"] for c in cols[f["child"]] if c["name"] in f["cols"])
        unique = len(f["cols"]) == 1 and (f["cols"][0] in uk.get(f["child"], set()) or set(f["cols"]) == pk.get(f["child"]))
        left = "|o" if nullable else "||"
        right = "o|" if unique else "o{"
        out.append(f'  {f["parent"]} {left}--{right} {f["child"]} : "{",".join(f["cols"])} ({f["on_delete"]})"')
    open(os.path.join(HERE, "er", f"er-{key}.mmd"), "w").write("\n".join(out) + "\n")


def main():
    build_db()
    dictionary, problems, stats = {}, [], {}
    for key, schema, sqlfile in (("platform", "platform", "platform.sql"), ("reference", "reference", "reference.sql"),
                                 ("tenant", TENANT, "tenant.sql")):
        docs = parse_sql(os.path.join(HERE, sqlfile))
        cols, pk, uk, fks = introspect(schema)
        stats[key] = (len(cols), len(fks))
        fk_of = {(f["child"], c): f for f in fks for i, c in enumerate(f["cols"])}
        for t in sorted(cols):
            d = docs.get(t)
            if not d or not d["description"]:
                problems.append(f"{key}.{t}: no table description")
                d = d or {"description": "", "columns": {}}
            entry = {"description": d["description"], "columns": {}}
            for c in cols[t]:
                text, _ = d["columns"].get(c["name"], ("", False))
                if not text:
                    problems.append(f"{key}.{t}.{c['name']}: no column comment")
                tags = [c["type"].replace("_array", "[]"), "NULL" if c["nullable"] else "NOT NULL"]
                if c["name"] in pk.get(t, set()):
                    tags.append("PK")
                if c["name"] in uk.get(t, set()):
                    tags.append("UNIQUE")
                f = fk_of.get((t, c["name"]))
                if f:
                    tags.append(f"FK -> {f['parent']}.{f['parent_cols'][f['cols'].index(c['name'])]} ON DELETE {f['on_delete'].upper()}")
                entry["columns"][c["name"]] = f"{text} [{', '.join(tags)}]" if text else ""
            dictionary[f"{key}.{t}"] = entry
        write_er(key, schema, docs, cols, pk, uk, fks)
    json.dump(dictionary, open(os.path.join(HERE, "dictionary.json"), "w"), indent=1, ensure_ascii=False)
    for k, (nt, nf) in stats.items():
        print(f"{k}: {nt} tables, {nf} foreign keys")
    for p in problems:
        print("PROBLEM:", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
