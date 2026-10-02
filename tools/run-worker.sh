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
#   Postgres, SMTP, IMAP and DoveSoft. None of them needs anything to reach
#   this machine.
#
#   Only CHAT is inbound — the web app calling /internal/turns — and that is
#   the one feature that needs AGENT_URL, a tunnel, and a public address.
#
# So run this and the live site gains everything except the chat panel, with
# no port open, no tunnel, and nothing on this laptop reachable from the
# internet. Chat is a separate decision with separate consequences; see
# DEPLOYING.md.
#
#   ./tools/run-worker.sh                 run (asks, or reads what you saved)
#   ./tools/run-worker.sh --reconfigure   ask every question again
#   ./tools/run-worker.sh --forget        delete the saved answers and stop
#
# Every credential is read at a HIDDEN prompt into this process's environment
# — never a file in the repo, an argument list (where `ps` shows it to every
# user on the machine) or shell history (§2.3). On a Mac the answers can be
# kept in the login Keychain, so the next run asks nothing: the Keychain is
# encrypted at rest and unlocked by your login, and each value goes to
# `security` on its STDIN, base64-encoded, never on its command line. On
# anything else, or if you decline, every run asks again.

set -euo pipefail
# The script's own absolute path, before the cd below: caffeinate re-runs it.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

# Appended, not prepended: a Terminal tab already has Node first on PATH, and
# this only finds it when the script is started from somewhere that has not
# (Homebrew's two prefixes and the nodejs.org installer's).
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"

MODE=run
case "${1:-}" in
  '') ;;
  --reconfigure) MODE=reconfigure ;;
  --forget) MODE=forget ;;
  *) echo "usage: $0 [--reconfigure | --forget]" >&2; exit 2 ;;
esac

# ── The Keychain (macOS only) ──────────────────────────────────────────────
#
# One generic-password item per variable, under one service name. Values are
# base64 so that `security -i`'s command parser never has to quote anything,
# and they reach it on stdin: `printf` is a shell builtin, so the value is in
# no process's argv at any point.
SERVICE="agency-os-worker"
SAVED_NAMES=(DATABASE_URL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD MAIL_FROM
  DOVESOFT_API_KEY DOVESOFT_ENTITY_ID IMAP_HOST IMAP_USER IMAP_PASSWORD
  WEB_PUBLIC_URL UNSUBSCRIBE_SECRET SLACK_WEBHOOK_URL)

have_keychain() { [ "$(uname -s)" = Darwin ] && command -v security >/dev/null 2>&1; }

kc_get() {
  local b64
  b64=$(security find-generic-password -s "$SERVICE" -a "$1" -w 2>/dev/null) || return 1
  [ -n "$b64" ] || return 1
  printf '%s' "$b64" | openssl base64 -d -A
}

kc_put() {
  local b64
  b64=$(printf '%s' "$2" | openssl base64 -A)
  printf 'add-generic-password -U -s %s -a %s -w %s\n' "$SERVICE" "$1" "$b64" | security -i >/dev/null 2>&1
}

kc_del() { security delete-generic-password -s "$SERVICE" -a "$1" >/dev/null 2>&1 || true; }

if [ "$MODE" = forget ]; then
  if ! have_keychain; then echo "Nothing is saved outside a Mac's Keychain; nothing to forget."; exit 0; fi
  for n in "${SAVED_NAMES[@]}"; do kc_del "$n"; done
  echo "The saved answers are gone from the Keychain. The next run asks again."
  exit 0
fi

# ── Before anything is asked: can this checkout run the worker at all? ───────
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "This needs Node.js 22 or newer (found: $(node -v 2>/dev/null || echo none))." >&2
  echo "Install it from https://nodejs.org (the LTS), then run this again." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Run 'npm ci' in this folder first, then run this again." >&2
  exit 1
fi

# Keep the Mac awake while the worker runs. Mail queued while the lid was
# shut is not lost — it goes, re-checked against every rule, when the worker
# next runs — but it goes late. -i (no idle sleep) and -s (no system sleep on
# power); the display may still sleep. Closing the lid on battery still
# sleeps the machine.
if [ "$(uname -s)" = Darwin ] && command -v caffeinate >/dev/null 2>&1 && [ -z "${AGENCY_CAFFEINATED:-}" ]; then
  # ${1+"$@"}, not "$@": macOS's bash 3.2 calls an empty "$@" unbound under set -u.
  AGENCY_CAFFEINATED=1 exec caffeinate -is "$SELF" ${1+"$@"}
fi

# ── Read what was saved, or ask ──────────────────────────────────────────────
LOADED="no"
if [ "$MODE" = run ] && have_keychain && kc_get DATABASE_URL >/dev/null; then
  for n in "${SAVED_NAMES[@]}"; do
    if v=$(kc_get "$n"); then export "$n=$v"; fi
  done
  unset v
  LOADED="yes"
  echo "Using the answers saved in your Keychain ('$0 --reconfigure' to change them)."
fi

ask_open() {
  # Opening it is the test; `[ -r /dev/tty ]` only reads the permission bits and
  # passes in places where the open then fails.
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then
    echo "This script needs a terminal — it asks for credentials at a hidden" >&2
    echo "prompt so they never reach a file, a log, an argument list or shell" >&2
    echo "history (§2.3). Run it in a Terminal tab." >&2
    exit 1
  fi
}

if [ "$LOADED" = no ]; then
  ask_open

  printf 'Production DATABASE_URL (Neon, direct/unpooled — hidden): ' >&3
  read -r -s V <&3; printf '\n' >&3
  [ -n "${V:-}" ] || { echo "Nothing entered. Stopping." >&2; exit 1; }
  export DATABASE_URL="$V"; unset V

  # ── Sending ──────────────────────────────────────────────────────────────
  # The worker treats every one of these as OPTIONAL and boots cleanly
  # without them, doing only the recovery jobs (apps/agent/src/worker.ts:
  # the mailbox on `SMTP_HOST && MAIL_FROM`, DoveSoft on `DOVESOFT_API_KEY &&
  # DOVESOFT_ENTITY_ID`, the inbox on `IMAP_HOST && IMAP_USER &&
  # IMAP_PASSWORD`). Skipping them gives a worker that reports itself healthy
  # and never sends; the summary below says so.
  printf 'Configure SENDING email now? Without it, approved mail waits in the queue. [y/N]: ' >&3
  read -r ANSWER <&3
  case "$ANSWER" in
    [yY]*)
      printf '  SMTP host [smtp.resend.com]: ' >&3;               read -r V <&3; export SMTP_HOST="${V:-smtp.resend.com}"
      printf '  SMTP port [465]: ' >&3;                           read -r V <&3; export SMTP_PORT="${V:-465}"
      printf '  SMTP username [resend]: ' >&3;                    read -r V <&3; export SMTP_USER="${V:-resend}"
      printf '  SMTP password (Resend: an API key — hidden): ' >&3; read -r -s V <&3; printf '\n' >&3
      [ -n "${V:-}" ] && export SMTP_PASSWORD="$V"
      printf '  From address (e.g. Your Name <hello@myagencyos.in>): ' >&3; read -r V <&3
      [ -n "${V:-}" ] && export MAIL_FROM="$V"
      unset V
      ;;
  esac

  printf 'Configure SMS through DoveSoft now? Without it, approved texts wait in the queue. [y/N]: ' >&3
  read -r ANSWER <&3
  case "$ANSWER" in
    [yY]*)
      printf '  DoveSoft API key (hidden): ' >&3;               read -r -s V <&3; printf '\n' >&3
      [ -n "${V:-}" ] && export DOVESOFT_API_KEY="$V"
      printf '  DLT principal entity id (PE ID, digits): ' >&3; read -r V <&3
      [ -n "${V:-}" ] && export DOVESOFT_ENTITY_ID="$V"
      unset V
      ;;
  esac

  printf 'Configure REPLY DETECTION now? Without it, nobody is marked as having replied. [y/N]: ' >&3
  read -r ANSWER <&3
  case "$ANSWER" in
    [yY]*)
      printf '  IMAP host [imap.gmail.com]: ' >&3;   read -r V <&3; export IMAP_HOST="${V:-imap.gmail.com}"
      printf '  IMAP username (the mailbox, e.g. hello@myagencyos.in): ' >&3; read -r V <&3
      [ -n "${V:-}" ] && export IMAP_USER="$V"
      printf '  IMAP password (hidden — a Google APP password, not the account one): ' >&3
      read -r -s V <&3; printf '\n' >&3
      [ -n "${V:-}" ] && export IMAP_PASSWORD="$V"
      unset V
      ;;
  esac

  # ── Links in mail, and the alarm ─────────────────────────────────────────
  # The worker adds List-Unsubscribe headers only with BOTH WEB_PUBLIC_URL and
  # UNSUBSCRIBE_SECRET, and the web app verifies the link with ITS copy of the
  # secret — so the two must hold the same value.
  printf 'Public address of the web app [https://myagencyos.in]: ' >&3
  read -r V <&3; export WEB_PUBLIC_URL="${V:-https://myagencyos.in}"; unset V

  if [ -n "${SMTP_HOST:-}" ]; then
    printf 'One-click unsubscribe: paste the UNSUBSCRIBE_SECRET that Vercel has (hidden),\n' >&3
    printf '  or press Enter to make a new one: ' >&3
    read -r -s V <&3; printf '\n' >&3
    if [ -n "${V:-}" ]; then
      export UNSUBSCRIBE_SECRET="$V"
    else
      export UNSUBSCRIBE_SECRET="$(openssl rand -hex 32)"
      if command -v pbcopy >/dev/null 2>&1; then
        printf '%s' "$UNSUBSCRIBE_SECRET" | pbcopy
        printf '  A new secret is on your clipboard (it is not shown). Paste it into Vercel →\n' >&3
      else
        printf '  A new secret was made. Copy it from the Keychain item below into Vercel →\n' >&3
      fi
      printf '  Settings → Environment Variables → UNSUBSCRIBE_SECRET (Production), then\n' >&3
      printf '  redeploy. Until the site has the same value, unsubscribe links are refused.\n' >&3
    fi
    unset V
  fi

  printf 'Slack webhook URL for the opt-out alarm (hidden; Enter to skip): ' >&3
  read -r -s V <&3; printf '\n' >&3
  [ -n "${V:-}" ] && export SLACK_WEBHOOK_URL="$V"
  unset V

  if have_keychain; then
    printf 'Remember these answers in your Keychain, so the next run asks nothing? [Y/n]: ' >&3
    read -r ANSWER <&3
    case "$ANSWER" in
      [nN]*) ;;
      *)
        for n in "${SAVED_NAMES[@]}"; do
          kc_del "$n"
          if [ -n "${!n:-}" ]; then
            kc_put "$n" "${!n}" || echo "  Could not save $n in the Keychain; the next run will ask for it." >&2
          fi
        done
        printf '  Saved under "%s" in your login Keychain.\n' "$SERVICE" >&3
        ;;
    esac
  fi
  exec 3>&-
fi

# ── Check what was given ─────────────────────────────────────────────────────
case "${DATABASE_URL:-}" in
  postgres://*|postgresql://*) ;;
  *) echo "DATABASE_URL does not look like a postgres:// connection string. Stopping." >&2; exit 1 ;;
esac
case "$DATABASE_URL" in
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

# 465 is implicit TLS; 587 and the rest are STARTTLS.
if [ -n "${SMTP_HOST:-}" ]; then
  if [ "${SMTP_PORT:-587}" = 465 ]; then export SMTP_SECURE=true; else export SMTP_SECURE=false; fi
fi
if [ -n "${IMAP_HOST:-}" ]; then export IMAP_PORT=993 IMAP_SECURE=true; fi

# Without the mailbox's two halves, sending is off: say so here rather than
# letting a worker that never sends report itself healthy.
SENDING=no;   [ -n "${SMTP_HOST:-}" ] && [ -n "${MAIL_FROM:-}" ] && SENDING=yes
SMS=no;       [ -n "${DOVESOFT_API_KEY:-}" ] && [ -n "${DOVESOFT_ENTITY_ID:-}" ] && SMS=yes
RECEIVING=no; [ -n "${IMAP_HOST:-}" ] && [ -n "${IMAP_USER:-}" ] && [ -n "${IMAP_PASSWORD:-}" ] && RECEIVING=yes

echo
echo "── What this worker will and will not do ──────────────────────────"
echo "  always:   recover stuck sends, expire approvals, sweep expired"
echo "            sign-in links, and write the heartbeat the site reads"
if [ "$SENDING" = yes ]; then
  echo "  sending:  ON  — approved outreach goes via $SMTP_HOST as $MAIL_FROM"
  if [ -n "${UNSUBSCRIBE_SECRET:-}" ] && [ -n "${WEB_PUBLIC_URL:-}" ]; then
    echo "            with a one-click unsubscribe link to $WEB_PUBLIC_URL"
  else
    echo "            WITHOUT an unsubscribe header (no UNSUBSCRIBE_SECRET)"
  fi
else
  echo "  sending:  OFF — approved mail WAITS in the queue. Nothing is lost,"
  echo "            and every §2.1 rule is re-checked when it does send."
fi
if [ "$SMS" = yes ]; then
  echo "  sms:      ON  — approved texts go through DoveSoft, each from a"
  echo "            registered DLT template, to a contact who opted in"
else
  echo "  sms:      OFF — approved texts WAIT in the queue."
fi
if [ "$RECEIVING" = yes ]; then
  echo "  replies:  ON  — reading $IMAP_USER over IMAP"
else
  echo "  replies:  OFF — replies are not read, so no contact is marked as"
  echo "            having replied and no sequence is paused by one."
fi
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "  alarm:    ON  — an opt-out that cannot be recorded is posted to Slack"
fi
echo "  chat:     OFF — no inbound route. The site's chat panel says no worker"
echo "            is connected, which is true."
echo
echo "  The worker logs its own verdict as 'outreach: <mode>' and"
echo "  'sms: dovesoft on|off' at boot. If that disagrees with this, trust it."
echo "  Closing this window stops it; queued mail waits for the next run."
echo

# The packages run as compiled JavaScript (packages/*/dist): build them, or a
# fresh checkout or a `git pull` runs stale code — or fails to start at all.
echo "Building the packages…"
npx tsc --build

# Required by the worker's schema, and with no tunnel nothing ever presents it:
# the web app only sends this header when it calls /internal/*, which it cannot
# reach. A fresh random value per run is therefore correct — it is a shared
# secret with nobody. If you later expose chat, set the SAME value here and in
# Vercel, and this line is what you replace.
AGENT_INTERNAL_TOKEN="$(openssl rand -base64 32)" \
  NODE_ENV=production \
  AGENT_BIND=127.0.0.1 \
  exec npx tsx apps/agent/src/index.ts
