#!/usr/bin/env bash
# =====================================================================================================
# alert.sh — e-mail the operator about a failure (ADR-0016). Root-owned copy: /usr/local/sbin/velexis-alert.
# Settings: /etc/velexis/alert.env (deploy/env/alert.env.example). Sends with curl over SMTP (no local MTA).
#
#   velexis-alert unit-failed <unit>          called by velexis-alert@.service (OnFailure= of every unit)
#   velexis-alert message "<subject>" <file>  called by scripts (health check, backup); body read from <file> or stdin
#
# TLS: ALERT_SMTP_TLS=required (the default) never sends without TLS: implicit TLS for smtps:// URLs, STARTTLS
# for smtp:// URLs. ALERT_SMTP_TLS=none sends plain SMTP and is accepted only for a loopback host, so a local test
# sink such as Mailpit (smtp://127.0.0.1:1025) works while alert mails never cross a network in clear text.
# Authentication: an empty ALERT_SMTP_USER sends without SMTP AUTH (Mailpit); otherwise the user and password go
# through a temporary netrc file, never on the command line. ALERT_SMTP_URL must not carry user info.
#
# Finalised by task X-021 (deploy/systemd/test/units-smoke.sh sends a real alert to Mailpit); X-030 adds the
# health-check callers. Logs are already redacted by the apps; this script adds no request data.
# =====================================================================================================
set -euo pipefail
umask 077

if [ -z "${ALERT_SMTP_URL:-}" ] && [ -f /etc/velexis/alert.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/velexis/alert.env
  set +a
fi
: "${ALERT_SMTP_URL:?set in /etc/velexis/alert.env}"
: "${ALERT_FROM:?}" "${ALERT_TO:?}"
: "${ALERT_HOST_LABEL:=$(hostname)}"
: "${ALERT_SMTP_TLS:=required}"

die() { echo "velexis-alert: $*" >&2; exit 2; }

case "$ALERT_SMTP_URL" in
  smtp://*|smtps://*) ;;
  *) die "ALERT_SMTP_URL must start with smtp:// or smtps://" ;;
esac
# No user info in the URL: credentials would show on curl's command line (ps), and "smtp://127.0.0.1:x@host"
# would make curl connect to host while the loopback check below sees 127.0.0.1.
case "$ALERT_SMTP_URL" in
  *@*) die "ALERT_SMTP_URL must not contain user info; set ALERT_SMTP_USER and ALERT_SMTP_PASSWORD" ;;
esac
SMTP_SCHEME="${ALERT_SMTP_URL%%://*}"
SMTP_HOST="$(printf '%s\n' "$ALERT_SMTP_URL" | sed -E 's#^[a-z]+://(\[[^]]*\]|[^:/]+).*#\1#')"

TLS_ARGS=()
case "$ALERT_SMTP_TLS" in
  required)
    TLS_ARGS=(--ssl-reqd) ;;
  none)
    [ "$SMTP_SCHEME" = smtp ] || die "ALERT_SMTP_TLS=none needs an smtp:// URL (smtps:// is always TLS)"
    # Loopback literals only: a name such as 127.example.com can resolve to any address.
    [[ "$SMTP_HOST" =~ ^(localhost|\[::1\]|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$ ]] \
      || die "ALERT_SMTP_TLS=none is only allowed for a loopback SMTP host (a local test sink), not $SMTP_HOST" ;;
  *) die "ALERT_SMTP_TLS must be required or none" ;;
esac

MSG="$(mktemp)"
NETRC="$(mktemp)"
trap 'rm -f "$MSG" "$NETRC"' EXIT

case "${1:-}" in
  unit-failed)
    UNIT="${2:?unit name}"
    SUBJECT="[velexis][$ALERT_HOST_LABEL] $UNIT failed"
    BODY="$(
      echo "Unit $UNIT entered the failed state at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
      echo "Release: $(readlink -f /srv/velexis/current 2>/dev/null || echo none)"
      echo
      systemctl status --no-pager --lines=0 "$UNIT" 2>&1 || true
      echo
      echo "Last log lines:"
      journalctl -u "$UNIT" -n 40 --no-pager -o short-iso 2>&1 || true
    )" ;;
  message)
    SUBJECT="[velexis][$ALERT_HOST_LABEL] ${2:?subject}"
    if [ -n "${3:-}" ]; then BODY="$(cat "$3")"; else BODY="$(cat)"; fi ;;
  *)
    echo "usage: velexis-alert unit-failed <unit> | message <subject> [body-file]" >&2
    exit 2 ;;
esac

{
  echo "From: $ALERT_FROM"
  echo "To: $ALERT_TO"
  echo "Subject: $SUBJECT"
  echo "Date: $(date -R)"
  echo "Content-Type: text/plain; charset=utf-8"
  echo
  # SMTP allows at most 998 bytes per line; JSON log lines can be longer.
  printf '%s\n' "$BODY" | fold -b -w 990
} > "$MSG"

AUTH_ARGS=()
if [ -n "${ALERT_SMTP_USER:-}" ]; then
  printf 'machine %s login %s password %s\n' "$SMTP_HOST" "$ALERT_SMTP_USER" "${ALERT_SMTP_PASSWORD:-}" > "$NETRC"
  AUTH_ARGS=(--netrc-file "$NETRC")
fi

# --crlf: SMTP lines end in CRLF; providers that refuse bare line feeds (SMTP smuggling fixes) accept the mail.
curl --silent --show-error --connect-timeout 15 --max-time 60 --crlf "${TLS_ARGS[@]}" "${AUTH_ARGS[@]}" \
  --url "$ALERT_SMTP_URL" \
  --mail-from "$ALERT_FROM" --mail-rcpt "$ALERT_TO" \
  --upload-file "$MSG"
echo "velexis-alert: sent \"$SUBJECT\" to $ALERT_TO"
