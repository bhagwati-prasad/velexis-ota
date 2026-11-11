#!/usr/bin/env bash
# =====================================================================================================
# build-caddy.sh — build the Velexis Caddy: Caddy 2.8 with the Coraza web application firewall and the OWASP Core Rule
# Set, reproducibly, from the versions pinned in versions.env (task X-039; ADR-0027 row 6.4.2;
# docs/mvp/deployment-single-vm.md §6).
#
#   bash deploy/caddy/build/build-caddy.sh <out-folder>     -> <out-folder>/caddy, and its SHA-256 on the last line
#
# pack-release.sh runs it for every release (the build job of deploy.yml, and the dry run of ci.yml) and puts the binary
# in the release as caddy/bin/caddy; velexis-deploy installs it on the VM as /usr/local/bin/caddy-velexis. ci.yml's
# deploy-files job builds it for caddy-smoke.sh.
#
# How (every step fails closed):
#   1. reads versions.env (KEY=value lines only, never sourced);
#   2. downloads the Go toolchain as the golang.org/toolchain module zip from proxy.golang.org and checks its SHA-256
#      against GO_TOOLCHAIN_SHA256 (dl.google.com and go.dev are not needed);
#   3. with that toolchain alone (GOTOOLCHAIN=local) and a clean environment: installs xcaddy at XCADDY_VERSION and
#      builds Caddy at CADDY_VERSION with coraza-caddy, Coraza and coraza-coreruleset at their versions. Modules come
#      only from proxy.golang.org and are checked against sum.golang.org. xcaddy builds with -trimpath, -ldflags "-w -s"
#      and no cgo; -buildvcs=false keeps any checkout's state out of the binary;
#   4. checks the binary's build information: the Go version, every pinned module version, -trimpath, no cgo, the target
#      platform;
#   5. checks that deploy/caddy/waf/logdata.conf has one line for exactly the Core Rule Set rules that write logdata,
#      of the rule files that the Caddyfile loads (else it keeps a regenerated logdata.conf in the work folder and
#      stops);
#   6. sets the binary's modification time to SOURCE_DATE_EPOCH, and checks its SHA-256 against CADDY_SHA256. The build
#      is reproducible, so a different SHA-256 means a different input: the pin is the check that two builds (CI, the
#      release, a developer's machine) give the same binary.
# Only <out-folder>/caddy is written to the output folder (pack-release.sh lists every file of a release).
#
# Needs: Linux on x86_64 (the toolchain pin is linux-amd64), bash, curl, unzip, sha256sum, awk and coreutils; outbound
# HTTPS to proxy.golang.org (with its storage redirect) and sum.golang.org, through HTTPS_PROXY when the environment sets
# one. About 1 to 3 minutes and 1.5 GB of temporary disk space without a cache.
#
# Settings (environment):
#   CADDY_BUILD_CACHE=<folder>  keep the toolchain zip and Go's module and build caches there between runs (CI caches it;
#                               the zip is checked again on every run, and the result must still match CADDY_SHA256)
#   CADDY_BUILD_KEEP=1          keep the temporary work folder (the build log, xcaddy's module)
#   TMPDIR                      parent of the work folder (default /tmp)
# =====================================================================================================
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS="$HERE/versions.env"
LOGDATA_CONF="$(cd "$HERE/.." && pwd)/waf/logdata.conf"

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'build-caddy.sh: ERROR: %s\n' "$*" >&2; exit 1; }

if [ $# -ne 1 ] || [ -z "$1" ]; then die "usage: bash deploy/caddy/build/build-caddy.sh <out-folder>"; fi
OUT_DIR="$1"

# ---- 1. versions.env ------------------------------------------------------------------------------------------
REQUIRED_KEYS="GO_VERSION GO_TOOLCHAIN_SHA256 XCADDY_VERSION CADDY_VERSION CORAZA_CADDY_VERSION CORAZA_VERSION
CORERULESET_VERSION TARGET_GOOS TARGET_GOARCH TARGET_GOAMD64 SOURCE_DATE_EPOCH CADDY_SHA256"
declare -A PIN=()
[ -r "$VERSIONS" ] || die "cannot read $VERSIONS"
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  case "$line" in '' | '#'*) continue ;; esac
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._+/-]+)$ ]] || die "versions.env:$lineno is not a KEY=value line"
  PIN[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
done <"$VERSIONS"
for key in $REQUIRED_KEYS; do
  [ -n "${PIN[$key]:-}" ] || die "versions.env has no $key"
done
[[ "${PIN[GO_VERSION]}" =~ ^1\.[0-9]+\.[0-9]+$ ]] || die "versions.env: GO_VERSION must be a Go release such as 1.27.4"
for key in GO_TOOLCHAIN_SHA256 CADDY_SHA256; do
  [[ "${PIN[$key]}" =~ ^[0-9a-f]{64}$ ]] || die "versions.env: $key must be 64 lower-case hex digits"
done
for key in XCADDY_VERSION CADDY_VERSION CORAZA_CADDY_VERSION CORAZA_VERSION CORERULESET_VERSION; do
  [[ "${PIN[$key]}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "versions.env: $key must be a release tag such as v1.2.3"
done
[[ "${PIN[SOURCE_DATE_EPOCH]}" =~ ^[0-9]{9,10}$ ]] || die "versions.env: SOURCE_DATE_EPOCH must be seconds since 1970"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  die "the pinned Go toolchain is linux-amd64: build on Linux x86_64 (CI, the deploy job, a Linux machine)"
fi
for tool in curl unzip sha256sum awk sort touch; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done

# ---- work folder and caches ------------------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/velexis-caddy-build.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
KEEP_WORK="${CADDY_BUILD_KEEP:-0}"
cleanup() {
  local rc=$?
  if [ "$KEEP_WORK" = 1 ]; then
    log "kept the work folder $WORK"
  else
    chmod -R u+w "$WORK" 2>/dev/null || true # Go makes its module cache read-only
    rm -rf "$WORK"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [ -n "${CADDY_BUILD_CACHE:-}" ]; then
  mkdir -p "$CADDY_BUILD_CACHE"
  CACHE="$(cd "$CADDY_BUILD_CACHE" && pwd -P)"
else
  CACHE="$WORK/cache"
fi
mkdir -p "$CACHE/gomodcache" "$CACHE/gocache" "$WORK/home" "$WORK/tmp" "$WORK/bin" "$WORK/gopath"
BUILD_LOG="$WORK/build.log"
: >"$BUILD_LOG"

# ---- 2. the Go toolchain ----------------------------------------------------------------------------------------
ZIP_NAME="v0.0.1-go${PIN[GO_VERSION]}.linux-amd64.zip"
ZIP="$CACHE/golang-toolchain-$ZIP_NAME"
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
if [ -f "$ZIP" ] && [ "$(sha_of "$ZIP")" = "${PIN[GO_TOOLCHAIN_SHA256]}" ]; then
  log "Go ${PIN[GO_VERSION]}: the cached toolchain zip matches GO_TOOLCHAIN_SHA256"
else
  log "Go ${PIN[GO_VERSION]}: download golang.org/toolchain@$ZIP_NAME from proxy.golang.org"
  rm -f "$ZIP" "$ZIP.part"
  curl -fsSL --retry 3 --max-time 600 -o "$ZIP.part" "https://proxy.golang.org/golang.org/toolchain/@v/$ZIP_NAME" \
    || die "could not download the Go toolchain from proxy.golang.org"
  got="$(sha_of "$ZIP.part")"
  [ "$got" = "${PIN[GO_TOOLCHAIN_SHA256]}" ] \
    || { rm -f "$ZIP.part"; die "the Go toolchain zip has SHA-256 $got, versions.env pins ${PIN[GO_TOOLCHAIN_SHA256]}"; }
  mv "$ZIP.part" "$ZIP"
fi
unzip -q "$ZIP" -d "$WORK/toolchain" || die "could not unpack the Go toolchain"
GOROOT_DIR="$WORK/toolchain/golang.org/toolchain@v0.0.1-go${PIN[GO_VERSION]}.linux-amd64"
[ -x "$GOROOT_DIR/bin/go" ] || die "the toolchain zip has no bin/go"

# A clean environment for every go and xcaddy command: only the toolchain, the pinned module sources and the target.
# The proxy settings of the calling environment pass through (they change how modules are fetched, not what is built).
GO_ENV=(env -i
  "PATH=$GOROOT_DIR/bin:$WORK/bin:/usr/bin:/bin"
  "HOME=$WORK/home" "TMPDIR=$WORK/tmp"
  "GOROOT=$GOROOT_DIR" "GOPATH=$WORK/gopath" "GOMODCACHE=$CACHE/gomodcache" "GOCACHE=$CACHE/gocache" "GOBIN=$WORK/bin"
  GOENV=off GOTOOLCHAIN=local GOTELEMETRY=off
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GONOSUMDB= GONOPROXY= GOPRIVATE= GOINSECURE=
  "GOFLAGS=-mod=mod -buildvcs=false" CGO_ENABLED=0
  XCADDY_SUDO=0 XCADDY_SETCAP=0 XCADDY_SKIP_CLEANUP=0)
for name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy SSL_CERT_FILE SSL_CERT_DIR; do
  if [ -n "${!name:-}" ]; then GO_ENV+=("$name=${!name}"); fi
done
in_dir() { # folder command... -> runs the command in that folder
  local dir="$1"
  shift
  (cd "$dir" && "$@")
}
run_logged() { # what command... -> runs it with its output in the build log; on failure shows the log's end
  local what="$1"
  shift
  log "$what"
  if ! "$@" >>"$BUILD_LOG" 2>&1 </dev/null; then
    tail -n 25 "$BUILD_LOG" >&2
    die "$what failed (log above; CADDY_BUILD_KEEP=1 keeps $BUILD_LOG)"
  fi
}
got_go="$("${GO_ENV[@]}" go version)" || die "the Go toolchain does not run"
[ "$got_go" = "go version go${PIN[GO_VERSION]} linux/amd64" ] || die "unexpected toolchain: $got_go"

# ---- 3. xcaddy and the build ---------------------------------------------------------------------------------------
run_logged "xcaddy ${PIN[XCADDY_VERSION]}" \
  "${GO_ENV[@]}" go install -trimpath "github.com/caddyserver/xcaddy/cmd/xcaddy@${PIN[XCADDY_VERSION]}"
TARGET_ENV=("GOOS=${PIN[TARGET_GOOS]}" "GOARCH=${PIN[TARGET_GOARCH]}" "GOAMD64=${PIN[TARGET_GOAMD64]}")
BINARY="$WORK/caddy"
run_logged "Caddy ${PIN[CADDY_VERSION]} with coraza-caddy ${PIN[CORAZA_CADDY_VERSION]}, Coraza ${PIN[CORAZA_VERSION]}, coraza-coreruleset ${PIN[CORERULESET_VERSION]} (${PIN[TARGET_GOOS]}/${PIN[TARGET_GOARCH]})" \
  in_dir "$WORK/tmp" "${GO_ENV[@]}" "${TARGET_ENV[@]}" xcaddy build "${PIN[CADDY_VERSION]}" --output "$BINARY" \
  --with "github.com/corazawaf/coraza-caddy/v2@${PIN[CORAZA_CADDY_VERSION]}" \
  --with "github.com/corazawaf/coraza/v3@${PIN[CORAZA_VERSION]}" \
  --with "github.com/corazawaf/coraza-coreruleset/v4@${PIN[CORERULESET_VERSION]}"
[ -f "$BINARY" ] || die "xcaddy wrote no binary"

# ---- 4. the build information --------------------------------------------------------------------------------------
INFO="$("${GO_ENV[@]}" go version -m "$BINARY")" || die "cannot read the binary's build information"
printf '%s\n' "$INFO" >>"$BUILD_LOG"
info_has() { # whitespace-separated fields... -> the build information has a line with exactly these fields
  awk -v want="$*" '{ $1 = $1; line = $0 } line == want { found = 1 } END { exit !found }' <<<"$INFO"
}
problems=""
expect() { info_has "$@" || problems="$problems; no '$*'"; }
[ "$(head -n 1 <<<"$INFO" | awk '{ print $2 }')" = "go${PIN[GO_VERSION]}" ] || problems="$problems; not built with go${PIN[GO_VERSION]}"
for dep in "github.com/caddyserver/caddy/v2 ${PIN[CADDY_VERSION]}" \
  "github.com/corazawaf/coraza-caddy/v2 ${PIN[CORAZA_CADDY_VERSION]}" \
  "github.com/corazawaf/coraza/v3 ${PIN[CORAZA_VERSION]}" \
  "github.com/corazawaf/coraza-coreruleset/v4 ${PIN[CORERULESET_VERSION]}"; do
  read -r path version <<<"$dep"
  awk -v p="$path" -v v="$version" '$1 == "dep" && $2 == p && $3 == v && $4 ~ /^h1:/ { found = 1 } END { exit !found }' \
    <<<"$INFO" || problems="$problems; $path is not $version"
done
if grep -qE '^[[:space:]]+=>' <<<"$INFO"; then problems="$problems; a module is replaced"; fi
expect build -trimpath=true
expect build CGO_ENABLED=0
expect build "GOOS=${PIN[TARGET_GOOS]}"
expect build "GOARCH=${PIN[TARGET_GOARCH]}"
expect build "GOAMD64=${PIN[TARGET_GOAMD64]}"
[ -z "$problems" ] || die "the binary's build information does not match versions.env:${problems#;}"

# ---- 5. logdata.conf covers exactly the Core Rule Set rules that write logdata ----------------------------------------
CRS_RULES="$CACHE/gomodcache/github.com/corazawaf/coraza-coreruleset/v4@${PIN[CORERULESET_VERSION]}/rules/@owasp_crs"
[ -d "$CRS_RULES" ] || die "the module cache has no $CRS_RULES"
crs_logdata_ids() { # rules folder -> the ids of the rules whose actions set logdata, one per line, sorted
  # The rule files that the Caddyfile's (waf) snippet loads: the request rules and the correlation summary.
  # A directive continues on the next line after a backslash; the id is the first id: of a SecRule or SecAction.
  awk '
    /\\$/ { buf = buf substr($0, 1, length($0) - 1) " "; next }
    {
      text = buf $0
      buf = ""
      if (text ~ /^[ \t]*(SecRule|SecAction)[ \t]/ && text ~ /logdata:/ && match(text, /[" ,]id:[0-9]+/)) {
        print substr(text, RSTART + 4, RLENGTH - 4)
      }
    }' "$1"/REQUEST-*.conf "$1"/RESPONSE-980-CORRELATION.conf | sort -n -u
}
logdata_conf_of() { # ids on stdin -> the logdata.conf for them
  cat <<EOF
# =====================================================================================================
# logdata.conf — what a matched rule of the OWASP Core Rule Set writes to the WAF log (task X-039;
# docs/mvp/deployment-single-vm.md §6 and §12). Generated by deploy/caddy/build/build-caddy.sh for coraza-coreruleset
# ${PIN[CORERULESET_VERSION]}; do not edit by hand. Installed root-owned as /etc/caddy/waf/logdata.conf and loaded by every
# coraza_waf of the Caddyfile right after the Core Rule Set's rule files (REQUEST-*.conf, RESPONSE-980-CORRELATION.conf).
#
# The rules' own logdata quotes what matched: a piece of a query, header, cookie or body value (%{MATCHED_VAR},
# %{TX.0}, ...), which can be a password, a token, card data or a person's name. Each line below keeps only the name of
# the variable that matched (for example ARGS:json.travellers.0.lastName), so the log still says which rule matched
# which argument, as an exclusion needs (exclusions.conf), but never a value. build-caddy.sh fails when this list and
# the Core Rule Set of versions.env differ, and then keeps the regenerated file in its work folder.
# =====================================================================================================
EOF
  while read -r id; do
    printf 'SecRuleUpdateActionById %s "logdata:'"'"'%%{MATCHED_VAR_NAME}'"'"'"\n' "$id"
  done
}
EXPECTED_LOGDATA="$WORK/logdata.conf"
crs_logdata_ids "$CRS_RULES" | logdata_conf_of >"$EXPECTED_LOGDATA"
[ "$(grep -c '^SecRuleUpdateActionById ' "$EXPECTED_LOGDATA")" -gt 100 ] \
  || die "found too few Core Rule Set rules with logdata in $CRS_RULES; the reader no longer understands the rule files"
if ! cmp -s "$EXPECTED_LOGDATA" "$LOGDATA_CONF"; then
  KEEP_WORK=1
  die "deploy/caddy/waf/logdata.conf does not match the Core Rule Set ${PIN[CORERULESET_VERSION]}: copy $EXPECTED_LOGDATA over it (and review the difference)"
fi

# ---- 6. the fixed build time and the SHA-256 -------------------------------------------------------------------------
chmod 0755 "$BINARY"
touch -d "@${PIN[SOURCE_DATE_EPOCH]}" "$BINARY"
SHA="$(sha_of "$BINARY")"
log "built caddy: $SHA"
if [ "$SHA" != "${PIN[CADDY_SHA256]}" ]; then
  die "the binary's SHA-256 is $SHA, versions.env pins ${PIN[CADDY_SHA256]}. After a version change put the new value in CADDY_SHA256 (and build twice to see the same value); without one the build is not reproducible here"
fi

mkdir -p "$OUT_DIR"
install -m 0755 "$BINARY" "$OUT_DIR/caddy.part"
touch -d "@${PIN[SOURCE_DATE_EPOCH]}" "$OUT_DIR/caddy.part"
mv -f "$OUT_DIR/caddy.part" "$OUT_DIR/caddy"
log "$OUT_DIR/caddy: Caddy ${PIN[CADDY_VERSION]} with Coraza (Go ${PIN[GO_VERSION]}), the pinned build of versions.env"
printf 'caddy %s\n' "$SHA"
