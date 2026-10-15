#!/usr/bin/env bash
# =====================================================================================================
# pack-release.sh — assemble one self-contained release folder from a BUILT workspace (runs in CI).
#
# Used by the build job of .github/workflows/deploy.yml after `pnpm build` (task X-023), and as a dry run by ci.yml.
# Usage:   bash deploy/scripts/pack-release.sh [out-root]        -> <out-root>/<git-sha>/  (default: release/)
# SHA256SUMS lists every regular file; velexis-deploy (deploy.sh) refuses an upload with a changed, missing or
# unlisted file, so nothing may be added to the folder after this script.
#
# Layout of a release (docs/mvp/deployment-single-vm.md §8). Apps that do not exist yet are skipped, so the
# same script packs the M0 "hello world" (migrations, the migration CLI, the apps scaffolded so far, the storefront
# or its placeholder page, deploy/) and the full system.
#   RELEASE.json            sha, ref, build time, Node version, list of apps
#   SHA256SUMS              checksums of every file (verified by deploy.sh before anything runs)
#   deploy/                 copy of deploy/ (units, Caddyfile, scripts; deploy.sh installs them as root)
#   db/                     @velexis/db (pnpm deploy --prod): migration CLI dist/cli/migrate.js
#   migrations/{platform,reference,tenant}/
#   reference-data/         @velexis/reference-data: loader CLI + vendored datasets
#   platform-backend/       @velexis/platform-backend: dist/main.js, dist/worker.js, openapi/, node_modules
#   ota-backend/            @velexis/ota-backend: dist/main.js, dist/worker.js, openapi/, node_modules
#   platform-frontend/      Next.js standalone tree; entry platform/frontend/server.js
#   platform-admin/         Next.js standalone tree; entry platform/admin/server.js
#   ota-admin/              Next.js standalone tree; entry ota/admin/server.js
#   storefront/             static files of ota/frontend (served by Caddy, world-readable)
# =====================================================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SHA="${RELEASE_SHA:-$(git rev-parse HEAD)}"
REF="${RELEASE_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
OUT_ROOT="${1:-release}"
OUT="$OUT_ROOT/$SHA"
APPS=()

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
has_pkg() { [ -f "$1/package.json" ]; }

# pnpm deploy copies the package's published files (its "files" field) plus production node_modules.
deploy_pkg() {
  local name="$1" dest="$2"
  log "pnpm deploy $name -> $dest"
  pnpm --filter "$name" deploy --prod "$OUT/$dest" >/dev/null
}

# Next.js apps are built with output: "standalone" and outputFileTracingRoot = repository root.
pack_next() {
  local src="$1" dest="$2" cache="$3"
  [ -f "$src/.next/standalone/$src/server.js" ] || die "$src: missing .next/standalone/$src/server.js (standalone output?)"
  log "Next.js standalone $src -> $dest"
  mkdir -p "$OUT/$dest"
  cp -a "$src/.next/standalone/." "$OUT/$dest/"
  cp -a "$src/.next/static" "$OUT/$dest/$src/.next/static"
  if [ -d "$src/public" ]; then cp -a "$src/public" "$OUT/$dest/$src/public"; fi
  # Runtime cache goes to the unit's CacheDirectory (/var/cache/velexis/<app>); the release stays read-only.
  rm -rf "$OUT/$dest/$src/.next/cache"
  ln -s "/var/cache/velexis/$cache" "$OUT/$dest/$src/.next/cache"
  APPS+=("$dest")
}

rm -rf "$OUT"
mkdir -p "$OUT"

# ---- Database: migration CLI and migration files --------------------------------------------------------
if has_pkg packages/db; then deploy_pkg @velexis/db db; fi
for set in platform reference; do
  if [ -d "platform/backend/migrations/$set" ]; then
    mkdir -p "$OUT/migrations/$set"
    cp -a "platform/backend/migrations/$set/." "$OUT/migrations/$set/"
  fi
done
if [ -d ota/backend/migrations/tenant ]; then
  mkdir -p "$OUT/migrations/tenant"
  cp -a ota/backend/migrations/tenant/. "$OUT/migrations/tenant/"
fi
if has_pkg tools/reference-data; then deploy_pkg @velexis/reference-data reference-data; fi

# ---- Backends ---------------------------------------------------------------------------------------------
if has_pkg platform/backend; then deploy_pkg @velexis/platform-backend platform-backend; APPS+=(platform-backend); fi
if has_pkg ota/backend; then deploy_pkg @velexis/ota-backend ota-backend; APPS+=(ota-backend); fi

# ---- Next.js apps -----------------------------------------------------------------------------------------
if has_pkg platform/frontend; then pack_next platform/frontend platform-frontend portal; fi
if has_pkg platform/admin; then pack_next platform/admin platform-admin platform-admin; fi
if has_pkg ota/admin; then pack_next ota/admin ota-admin ota-admin; fi

# ---- Storefront (static) ----------------------------------------------------------------------------------
if [ -d ota/frontend/dist ]; then
  log "storefront from ota/frontend/dist"
  cp -a ota/frontend/dist "$OUT/storefront"
  APPS+=(storefront)
else
  log "storefront: M0 placeholder page (ota/frontend is not built yet)"
  mkdir -p "$OUT/storefront"
  cat > "$OUT/storefront/index.html" <<EOF
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Velexis storefront</title></head>
<body><h1>Velexis</h1><p>Hello from release ${SHA:0:12}. The hosted storefront arrives in M2.</p></body></html>
EOF
  cp "$OUT/storefront/index.html" "$OUT/storefront/404.html"
fi

# ---- deploy/ and the manifest ------------------------------------------------------------------------------
mkdir -p "$OUT/deploy"
cp -a deploy/. "$OUT/deploy/"
find "$OUT/deploy" -name '*.env' -type f -delete   # never ship real env files, even by accident

node -e '
  const [sha, ref, apps] = process.argv.slice(1);
  const manifest = { sha, ref, builtAt: new Date().toISOString(), node: process.version,
    apps: apps ? apps.split(" ") : [] };
  require("fs").writeFileSync(process.argv[4] + "/RELEASE.json", JSON.stringify(manifest, null, 2) + "\n");
' "$SHA" "$REF" "${APPS[*]:-}" "$OUT"

SUMS_TMP="$(mktemp)"
( cd "$OUT" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$SUMS_TMP"
mv "$SUMS_TMP" "$OUT/SHA256SUMS"
chmod 0644 "$OUT/SHA256SUMS"

log "release ready: $OUT ($(du -sh "$OUT" | cut -f1)), apps: ${APPS[*]:-none}"
