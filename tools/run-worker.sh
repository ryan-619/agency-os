#!/usr/bin/env bash
#
# Run the agent worker on this machine, against the PRODUCTION database.
#
# This is the deployment for an agency that has not rented a server yet, and
# it is less of a compromise than it sounds — because of an asymmetry worth
# understanding before you read the rest:
#
#   Sending, reply detection, stuck-send recovery, the approval sweeper and
#   the expired-sign-in-token sweep are all this worker talking OUTBOUND to
#   Postgres and SMTP. None of them needs anything to reach this machine.
#
#   Only CHAT is inbound — the web app calling /internal/turns — and that is
#   the one feature that needs AGENT_URL, a tunnel, and a public address.
#
# So run this and the live site gains everything except the chat panel, with
# no port open, no tunnel, and nothing on this laptop reachable from the
# internet. Chat is a separate decision with separate consequences; see
# DEPLOYING.md.
#
#   ./tools/run-worker.sh
#
# The connection string is read from a hidden prompt into this process and
# nowhere else — no file, no argument list, no shell history (§2.3), the same
# way tools/remote-setup.sh does it.

set -euo pipefail
cd "$(dirname "$0")/.."

export PATH=/usr/local/bin:$PATH

# Opening it is the test; `[ -r /dev/tty ]` only reads the permission bits and
# passes in places where the open then fails.
if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  echo "This script needs a terminal — it asks for the connection string at a" >&2
  echo "hidden prompt so the credential never reaches a file, a log, an argument" >&2
  echo "list or shell history (§2.3). Run it in a Terminal tab." >&2
  exit 1
fi

printf 'Production DATABASE_URL (direct/unpooled): ' >&3
read -r -s DB <&3
printf '\n' >&3

if [ -z "${DB:-}" ]; then
  echo "Nothing entered. Stopping." >&2
  exit 1
fi
case "$DB" in
  postgres://*|postgresql://*) ;;
  *) echo "That does not look like a postgres:// connection string. Stopping." >&2; exit 1 ;;
esac
case "$DB" in
  *-pooler.*)
    echo >&2
    echo "That is the POOLED endpoint (its host contains '-pooler')." >&2
    echo >&2
    echo "The worker takes a session-scoped advisory lock so that exactly one" >&2
    echo "instance runs the outreach tick. PgBouncer in transaction mode does not" >&2
    echo "hold session state, so under the pooler TWO workers would each believe" >&2
    echo "they hold it — and both would send. Use the direct string." >&2
    exit 1
    ;;
esac

# Required by the worker's schema, and with no tunnel nothing ever presents it:
# the web app only sends this header when it calls /internal/*, which it cannot
# reach. A fresh random value per run is therefore correct — it is a shared
# secret with nobody. If you later expose chat, set the SAME value here and in
# Vercel, and this line is what you replace.
TOKEN="$(openssl rand -base64 32)"

echo
echo "── What this worker will and will not do ──────────────────────────"
echo "  will:  send queued outreach, detect replies, recover stuck sends,"
echo "         expire approvals, sweep expired sign-in links"
echo "  will NOT: answer chat — no model credential and no inbound route."
echo "         The site says 'no worker connected' on the chat panel, which"
echo "         is true and is better than a spinner that never resolves."
echo
echo "  Nothing on this machine is exposed. Closing this tab stops the worker;"
echo "  queued mail simply waits for the next run rather than being lost."
echo

exec 3>&-

DATABASE_URL="$DB" \
  AGENT_INTERNAL_TOKEN="$TOKEN" \
  NODE_ENV=production \
  AGENT_BIND=127.0.0.1 \
  npx tsx apps/agent/src/index.ts
