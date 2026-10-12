#!/usr/bin/env bash
# =====================================================================================================
# alert.sh — e-mail the operator about a failure (ADR-0016). Root-owned copy: /usr/local/sbin/velexis-alert.
# Settings: /etc/velexis/alert.env (deploy/env/alert.env.example). Sends with curl over SMTP (no local MTA).
#
#   velexis-alert unit-failed <unit>          called by velexis-alert@.service (OnFailure= of every unit)
#   velexis-alert message "<subject>" <file>  called by scripts (health check, backup); body read from <file> or stdin
#
# TEMPLATE: finalised by task X-021 (systemd) and extended by X-030 (health checks).
# Logs are already redacted by the apps; this script adds no request data.
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
  echo "$BODY"
} > "$MSG"

# Credentials go through a netrc file, never on the command line (visible in ps).
SMTP_HOST="$(echo "$ALERT_SMTP_URL" | sed -E 's#^[a-z]+://([^:/]+).*#\1#')"
printf 'machine %s login %s password %s\n' "$SMTP_HOST" "${ALERT_SMTP_USER:-}" "${ALERT_SMTP_PASSWORD:-}" > "$NETRC"

curl --silent --show-error --max-time 60 --ssl-reqd \
  --url "$ALERT_SMTP_URL" --netrc-file "$NETRC" \
  --mail-from "$ALERT_FROM" --mail-rcpt "$ALERT_TO" \
  --upload-file "$MSG"
