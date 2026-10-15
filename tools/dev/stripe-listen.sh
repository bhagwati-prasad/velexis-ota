#!/usr/bin/env bash
# =====================================================================================================
# stripe-listen.sh — forward Stripe test-mode webhooks to the local backends (X-028).
#
# Runbook: docs/mvp/local-development.md §6. Needs the Stripe CLI 1.x, logged in with `stripe login` (or
# STRIPE_API_KEY set to a test key). It only ever uses test mode: it never passes --live and refuses a live key.
# Automated tests do not need it; they sign fixture events with @velexis/testing/stripe.
#
# Usage:
#   bash tools/dev/stripe-listen.sh                    # both endpoints
#   bash tools/dev/stripe-listen.sh --only ota         # OTA customer payments only (M3)
#   bash tools/dev/stripe-listen.sh --only billing     # platform billing only (M5)
#   bash tools/dev/stripe-listen.sh --print-secrets    # print the .env.local lines and exit
#
# What it does:
#   1. reads the webhook signing secret of your Stripe CLI (`stripe listen --print-secret`; the CLI keeps one
#      per account and device, so both listeners use it) and prints the .env.local lines
#      STRIPE_WEBHOOK_SECRET_VELEXIS_TEST and STRIPE_BILLING_WEBHOOK_SECRET;
#   2. starts one `stripe listen` per endpoint, subscribed to the events its production endpoint receives
#      (ADR-0011 and ota/docs/adr/0010 for payments, ADR-0013 for billing), output prefixed [ota] or [billing]:
#        localhost:4000/webhooks/stripe/velexis/test   OTA API (ota-backend)
#        localhost:3100/webhooks/stripe/billing        platform API (platform-backend)
#   3. stops both on Ctrl-C, or when one of them exits.
# =====================================================================================================
set -euo pipefail

readonly PROD_MARKER=/etc/velexis
readonly OTA_URL=localhost:4000/webhooks/stripe/velexis/test
readonly BILLING_URL=localhost:3100/webhooks/stripe/billing
readonly OTA_EVENTS=payment_intent.amount_capturable_updated,payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,charge.refunded,charge.refund.updated,charge.dispute.created,charge.dispute.closed
readonly BILLING_EVENTS=checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.finalized,invoice.paid,invoice.payment_failed,invoice.voided

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

only=""
print_only=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      [ "$#" -ge 2 ] || die "--only needs ota or billing"
      case "$2" in
        ota | billing) only="$2" ;;
        *) die "--only takes ota or billing, not: $2" ;;
      esac
      shift 2
      ;;
    --print-secrets)
      print_only=true
      shift
      ;;
    -h | --help)
      sed -n '3,23p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1 (usage: bash tools/dev/stripe-listen.sh [--only ota|billing] [--print-secrets])" ;;
  esac
done
readonly only print_only

# ---- Development machines and test mode only ---------------------------------------------------------------
if [ -e "$PROD_MARKER" ]; then
  die "$PROD_MARKER exists, so this looks like a Velexis production host. stripe-listen.sh is for development" \
    "machines only; production webhooks are endpoints in the Stripe dashboard."
fi
case "${STRIPE_API_KEY:-}" in
  sk_live_* | rk_live_*) die "STRIPE_API_KEY holds a live key: stripe-listen.sh works in test mode only." ;;
  *) ;;
esac
command -v stripe >/dev/null 2>&1 \
  || die "the Stripe CLI is not installed: see docs/mvp/local-development.md §1 (Stripe CLI 1.x)"

# ---- The signing secret ------------------------------------------------------------------------------------
# Never echoed in an error message: only printed once, below, for .env.local.
if ! secret="$(stripe listen --print-secret)"; then
  die "stripe listen --print-secret failed: run 'stripe login' first (docs/mvp/local-development.md §6)"
fi
if [[ ! "$secret" =~ ^whsec_[A-Za-z0-9]+$ ]]; then
  die "stripe listen --print-secret did not print a whsec_ signing secret"
fi
readonly secret

printf '\nPut these lines into .env.local (the repository root one, or ota/backend/.env.local and\n'
printf 'platform/backend/.env.local), then restart the backends:\n\n'
if [ "$only" != billing ]; then
  printf 'STRIPE_WEBHOOK_SECRET_VELEXIS_TEST=%s\n' "$secret"
fi
if [ "$only" != ota ]; then
  printf 'STRIPE_BILLING_WEBHOOK_SECRET=%s\n' "$secret"
fi
printf '\n'
if [ "$print_only" = true ]; then
  exit 0
fi

# ---- The listeners -----------------------------------------------------------------------------------------
# Prefixes every line of one listener's output with its label.
prefix_lines() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '[%s] %s\n' "$1" "$line"
  done
}

ota_pid=""
billing_pid=""

# Whether a listener was started and still runs.
alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

stop_listeners() {
  local pid
  for pid in "$ota_pid" "$billing_pid"; do
    if alive "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap stop_listeners EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$only" != billing ]; then
  log "[ota] stripe listen --forward-to $OTA_URL"
  stripe listen --forward-to "$OTA_URL" --events "$OTA_EVENTS" > >(prefix_lines ota) 2>&1 &
  ota_pid=$!
fi
if [ "$only" != ota ]; then
  log "[billing] stripe listen --forward-to $BILLING_URL"
  stripe listen --forward-to "$BILLING_URL" --events "$BILLING_EVENTS" > >(prefix_lines billing) 2>&1 &
  billing_pid=$!
fi
log "Forwarding test-mode events; Ctrl-C stops both listeners."

# Wait until a listener exits (polling, because macOS ships bash 3.2, which has no `wait -n`).
while { [ -z "$ota_pid" ] || alive "$ota_pid"; } && { [ -z "$billing_pid" ] || alive "$billing_pid"; }; do
  sleep 1
done
status=0
for pid in "$ota_pid" "$billing_pid"; do
  if [ -n "$pid" ] && ! alive "$pid"; then
    wait "$pid" || status=$?
  fi
done
log "A listener stopped (exit status $status); stopping the other one."
stop_listeners
exit "$status"
