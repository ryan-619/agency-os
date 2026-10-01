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
# "Everything except chat" is conditional on the SMTP and IMAP prompts below.
# The worker treats those variables as optional and boots happily without
# them, doing only the recovery jobs — so skipping the prompts gives you a
# worker that runs, reports itself healthy, and never sends anything.
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

# ── Sending and reply detection ────────────────────────────────────────────
#
# These prompts exist because the worker treats every one of these variables as
# OPTIONAL and boots cleanly without them. apps/agent/src/worker.ts gives the
# sender a mail provider on `SMTP_HOST && MAIL_FROM` and an SMS provider on
# `DOVESOFT_API_KEY && DOVESOFT_ENTITY_ID` (0019), and starts the inbox on
# `IMAP_HOST && IMAP_USER && IMAP_PASSWORD`; unset, none is started,
# `outreachModeFrom` returns 'disabled', and the worker runs happily doing only
# the recovery jobs.
#
# That is a quiet failure with a loud banner in front of it: this script used
# to promise "send queued outreach, detect replies" while passing the child
# exactly four variables, none of them these. Approved messages would sit in
# the queue forever and replies would never be read, with nothing anywhere
# saying why.
#
# Sourcing the repo's .env would be worse than leaving it out: it points SMTP
# at the local mailpit sink on port 1025, so production outreach would go to a
# laptop instead of to a real inbox, and it has no IMAP settings at all.
#
# Passwords are read with `read -s` and EXPORTED rather than passed as
# `env VAR=value cmd`, which would put them in the child's argv where `ps`
# shows them to every user on the machine (§2.3).

SENDING="no"
RECEIVING="no"

printf 'Configure SENDING now? Without it, approved mail waits in the queue. [y/N]: ' >&3
read -r ANSWER <&3
case "$ANSWER" in
  [yY]*)
    printf '  SMTP host (e.g. smtp.resend.com): ' >&3;       read -r V_SMTP_HOST <&3
    printf '  SMTP port [587]: ' >&3;                        read -r V_SMTP_PORT <&3
    printf '  SMTP username (Resend uses "resend"): ' >&3;   read -r V_SMTP_USER <&3
    printf '  SMTP password (hidden): ' >&3;                 read -r -s V_SMTP_PASSWORD <&3; printf '\n' >&3
    printf '  From address (e.g. You <hello@outreach.example.com>): ' >&3
    read -r V_MAIL_FROM <&3
    if [ -n "$V_SMTP_HOST" ] && [ -n "$V_MAIL_FROM" ]; then
      export SMTP_HOST="$V_SMTP_HOST"
      export SMTP_PORT="${V_SMTP_PORT:-587}"
      export SMTP_SECURE="false"     # 587 is STARTTLS; 465 would be true
      [ -n "${V_SMTP_USER:-}" ]     && export SMTP_USER="$V_SMTP_USER"
      [ -n "${V_SMTP_PASSWORD:-}" ] && export SMTP_PASSWORD="$V_SMTP_PASSWORD"
      export MAIL_FROM="$V_MAIL_FROM"
      SENDING="yes"
    else
      echo "  Host and From are both required for sending; leaving it off." >&2
    fi
    unset V_SMTP_PASSWORD
    ;;
esac

SMS="no"
printf 'Configure SMS through DoveSoft now? Without it, approved texts wait in the queue. [y/N]: ' >&3
read -r ANSWER <&3
case "$ANSWER" in
  [yY]*)
    # The key is a credential: read hidden, exported, never echoed (§2.3).
    printf '  DoveSoft API key (hidden): ' >&3;               read -r -s V_DOVESOFT_KEY <&3; printf '\n' >&3
    printf '  DLT principal entity id (PE ID, digits): ' >&3; read -r V_DOVESOFT_ENTITY <&3
    if [ -n "${V_DOVESOFT_KEY:-}" ] && [ -n "${V_DOVESOFT_ENTITY:-}" ]; then
      export DOVESOFT_API_KEY="$V_DOVESOFT_KEY"
      export DOVESOFT_ENTITY_ID="$V_DOVESOFT_ENTITY"
      SMS="yes"
    else
      echo "  The key and the entity id are both required; leaving SMS off." >&2
    fi
    unset V_DOVESOFT_KEY
    ;;
esac

printf 'Configure REPLY DETECTION now? Without it, nobody is marked as having replied. [y/N]: ' >&3
read -r ANSWER <&3
case "$ANSWER" in
  [yY]*)
    printf '  IMAP host [imap.gmail.com]: ' >&3;   read -r V_IMAP_HOST <&3
    printf '  IMAP username (the mailbox): ' >&3;  read -r V_IMAP_USER <&3
    printf '  IMAP password (hidden — a Gmail APP password, not the account one): ' >&3
    read -r -s V_IMAP_PASSWORD <&3; printf '\n' >&3
    if [ -n "${V_IMAP_USER:-}" ] && [ -n "${V_IMAP_PASSWORD:-}" ]; then
      export IMAP_HOST="${V_IMAP_HOST:-imap.gmail.com}"
      export IMAP_PORT="993"
      export IMAP_SECURE="true"
      export IMAP_USER="$V_IMAP_USER"
      export IMAP_PASSWORD="$V_IMAP_PASSWORD"
      RECEIVING="yes"
    else
      echo "  Username and password are both required; leaving reply detection off." >&2
    fi
    unset V_IMAP_PASSWORD
    ;;
esac

echo
echo "── What this worker will and will not do ──────────────────────────"
echo "  always:   recover stuck sends, expire approvals, sweep expired"
echo "            sign-in links"
if [ "$SENDING" = "yes" ]; then
  echo "  sending:  ON  — queued outreach will be sent via $SMTP_HOST"
else
  echo "  sending:  OFF — approved mail WAITS in the queue. Nothing is lost,"
  echo "            and every §2.1 rule is re-checked when it does send."
fi
if [ "$SMS" = "yes" ]; then
  echo "  sms:      ON  — approved texts go through DoveSoft, each from a"
  echo "            registered DLT template, to a contact who opted in"
else
  echo "  sms:      OFF — approved texts WAIT in the queue."
fi
if [ "$RECEIVING" = "yes" ]; then
  echo "  replies:  ON  — polling $IMAP_USER over IMAP"
else
  echo "  replies:  OFF — replies are not read, so no contact is marked as"
  echo "            having replied and no sequence is paused by one."
fi
echo "  chat:     OFF — no model credential and no inbound route. The site"
echo "            says 'no worker connected' on the chat panel, which is true"
echo "            and better than a spinner that never resolves."
echo
echo "  The worker also logs its own verdict as 'outreach: <mode>' and"
echo "  'sms: dovesoft on|off' at boot."
echo "  If that says 'disabled' while this says ON, trust the worker."
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
