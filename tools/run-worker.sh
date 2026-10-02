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
# DEPLOYING.md. Answer yes to the CHAT question and this script points a
# Tailscale Funnel at the worker's API port (bearer-token gated) — this Mac's
# own https://<name>.<tailnet>.ts.net address, which does not change — and
# runs the worker with your Anthropic API key: every chat turn your teammates
# take is billed to that key.
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
  WEB_PUBLIC_URL UNSUBSCRIBE_SECRET SLACK_WEBHOOK_URL
  CHAT_URL ANTHROPIC_API_KEY AGENT_INTERNAL_TOKEN)

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

# ── Tailscale (chat's tunnel) ───────────────────────────────────────────────
#
# The CLI is `tailscale` on PATH (the Standalone app's "Install CLI", or
# Homebrew), or the App Store and Standalone apps' own executable. It only
# talks to the local Tailscale service, so it runs from an EMPTY environment:
# everything this script exports — the database URL, the mail passwords, the
# Anthropic key — would otherwise be inherited by a third party's binary.
TS=""
ts_find() {
  if command -v tailscale >/dev/null 2>&1; then TS=$(command -v tailscale)
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  else TS=""
  fi
  [ -n "$TS" ]
}
ts_run() { env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" "$TS" "$@"; }

# This Mac's name on the tailnet — the Funnel's host — when Tailscale is
# signed in and running; nothing, and a failure, otherwise.
ts_host() {
  ts_run status --json 2>/dev/null | node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s)
        const n = String((j.Self && j.Self.DNSName) || "").replace(/\.$/, "")
        if (j.BackendState !== "Running" || !/^[a-z0-9.-]+\.ts\.net$/i.test(n)) process.exit(1)
        process.stdout.write(n.toLowerCase())
      } catch { process.exit(1) }
    })'
}

# Whether a Funnel on <host>:443 is open to the internet and proxies to this
# worker's API port.
ts_funnel_serving() {
  ts_run funnel status --json 2>/dev/null | node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s)
        const key = process.argv[1] + ":443"
        const open = (j.AllowFunnel || {})[key] === true
        const proxies = JSON.stringify((j.Web || {})[key] || {}).includes("127.0.0.1:" + process.argv[2])
        process.exit(open && proxies ? 0 : 1)
      } catch { process.exit(1) }
    })' "$1" "$2"
}

# A tailscale command with a deadline, its output to a file: `funnel` waits,
# for as long as it takes, for Funnel to be approved for the tailnet, and an
# unattended start must not wait with it. 124 when the deadline passed.
ts_deadline() {
  local secs=$1 log=$2 pid i=0
  shift 2
  ts_run "$@" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge "$secs" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    i=$((i + 1))
  done
  wait "$pid"
}

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
# The lockfile's TypeScript and tsx, by path — never through npx, which
# installs and runs whatever the registry holds under that name when no
# local one exists (assuming --yes with no terminal), and the worker below
# runs with every production credential in its environment (review round 9,
# [9]; tools/production.sh does the same). Both are development
# dependencies, so an install with --omit=dev, or under NODE_ENV=production,
# leaves them out.
for tool in tsc tsx; do
  if [ ! -x "node_modules/.bin/$tool" ]; then
    echo "This checkout has no node_modules/.bin/$tool, which the worker is built and run with." >&2
    echo "Run 'npm ci' in this folder (it installs the development tools too), then run this again." >&2
    exit 1
  fi
done

# Keep the Mac awake while the worker runs. Mail queued while the lid was
# shut is not lost — it goes, re-checked against every rule, when the worker
# next runs — but it goes late. -i (no idle sleep) and -s (no system sleep on
# power); the display may still sleep. Closing the lid on battery still
# sleeps the machine.
if [ "$(uname -s)" = Darwin ] && command -v caffeinate >/dev/null 2>&1 && [ -z "${AGENCY_CAFFEINATED:-}" ]; then
  # ${1+"$@"}, not "$@": macOS's bash 3.2 calls an empty "$@" unbound under set -u.
  AGENCY_CAFFEINATED=1 exec caffeinate -is "$SELF" ${1+"$@"}
fi

# ── Build, before any answer is read or asked ────────────────────────────────
# The packages run as compiled JavaScript (packages/*/dist): build them, or a
# fresh checkout or a `git pull` runs stale code — or fails to start at all.
# Here, before a single credential is in this process's environment, so the
# build and everything it runs see none of them (review round 9, [9]).
echo "Building the packages…"
node_modules/.bin/tsc --build

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

# A server name, asked until it is one: an address typed where the server
# goes ("you@example.com") is a mailbox no worker can ever connect to, and it
# reconnects every five minutes for ever with nothing on screen saying why.
ask_host() {
  local prompt=$1 default=$2 v
  while :; do
    printf '  %s [%s]: ' "$prompt" "$default" >&3
    read -r v <&3
    v="${v:-$default}"
    if [[ "$v" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
      printf '%s' "$v"
      return 0
    fi
    printf '    That is not a server name (it should look like %s). Try again.\n' "$default" >&3
  done
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
      SMTP_HOST=$(ask_host 'SMTP host' smtp.resend.com); export SMTP_HOST
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
      IMAP_HOST=$(ask_host 'IMAP host' imap.gmail.com); export IMAP_HOST
      # Gmail and Google Workspace sign in with the WHOLE address; a bare
      # name is refused by the server on every reconnect.
      while :; do
        printf '  IMAP username (the whole mailbox address, e.g. hello@myagencyos.in): ' >&3; read -r V <&3
        case "$IMAP_HOST:${V:-}" in
          imap.gmail.com:*@*.* | imap.gmail.com: ) break ;;
          imap.gmail.com:*) printf '    Google needs the whole address, e.g. %s@yourdomain. Try again.\n' "$V" >&3 ;;
          *) break ;;
        esac
      done
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
  # secret — so the two must hold the same value. A link minted under any
  # other value is refused with a 404: a one-click unsubscribe from a mail
  # client shows the person nothing, and nothing is recorded (review round 9,
  # [2] and [7]). So this script never makes one up on a key press. Enter
  # keeps the secret saved here before, or sends no unsubscribe header at all
  # — the worker then mails without one, and a "stop" reply is still read. A
  # new secret is made only when asked for by name, and only where it can be
  # both put on the clipboard (for Vercel) and saved (for the next run),
  # because Vercel keeps it Sensitive and can never show it back, and the
  # Keychain holds it base64-encoded.
  printf 'Public address of the web app [https://myagencyos.in]: ' >&3
  read -r V <&3; export WEB_PUBLIC_URL="${V:-https://myagencyos.in}"; unset V

  SAVED_UNSUBSCRIBE=""
  if have_keychain; then SAVED_UNSUBSCRIBE=$(kc_get UNSUBSCRIBE_SECRET) || SAVED_UNSUBSCRIBE=""; fi
  CAN_MAKE=no
  if have_keychain && command -v pbcopy >/dev/null 2>&1; then CAN_MAKE=yes; fi
  # The name of a new secret this run put on the clipboard, and not yet
  # replaced: a second one must not overwrite it before it is in Vercel.
  ON_CLIPBOARD=""

  # What Enter means: the saved secret where there is one, else no header.
  keep_or_none() {
    if [ -n "$SAVED_UNSUBSCRIBE" ]; then
      export UNSUBSCRIBE_SECRET="$SAVED_UNSUBSCRIBE"
      printf '  Kept the UNSUBSCRIBE_SECRET saved in your Keychain.\n' >&3
    else
      unset UNSUBSCRIBE_SECRET
      printf '  No UNSUBSCRIBE_SECRET: mail goes WITHOUT a one-click unsubscribe header,\n' >&3
      printf '  and a "stop" reply is still read. Run with --reconfigure to add one.\n' >&3
    fi
  }

  # A new secret: on the clipboard first, then saved at once — not only if
  # the answers are remembered below, or the next run would load the old one
  # while Vercel holds this — and used only if both worked.
  make_new() {
    printf '  A NEW secret means every unsubscribe link already mailed under the old one\n' >&3
    printf '  stops working, and no link mailed by this worker works until Vercel holds\n' >&3
    printf '  the same new value. Make one only if Vercel has none, or you are replacing it.\n' >&3
    printf '  Make a new UNSUBSCRIBE_SECRET? [y/N]: ' >&3
    read -r ANSWER <&3
    case "$ANSWER" in
      [yY]*) ;;
      *) keep_or_none; return 0 ;;
    esac
    local fresh
    fresh=$(openssl rand -hex 32)
    if ! printf '%s' "$fresh" | pbcopy; then
      printf '  Could not put a new secret on the clipboard, so none was made.\n' >&3
      keep_or_none; return 0
    fi
    # Read back, not trusted: `security -i` can answer 0 for a command it refused.
    if ! kc_put UNSUBSCRIBE_SECRET "$fresh" || [ "$(kc_get UNSUBSCRIBE_SECRET || true)" != "$fresh" ]; then
      printf '' | pbcopy || true
      printf '  Could not save a new secret in your Keychain, so none was made.\n' >&3
      keep_or_none; return 0
    fi
    export UNSUBSCRIBE_SECRET="$fresh"
    SAVED_UNSUBSCRIBE="$fresh"
    ON_CLIPBOARD=UNSUBSCRIBE_SECRET
    printf '  A new secret is on your clipboard (it is not shown) and saved in your Keychain.\n' >&3
    printf '  Paste it into Vercel → Settings → Environment Variables → UNSUBSCRIBE_SECRET\n' >&3
    printf '  (Production), then redeploy. Until the site has the same value, every link\n' >&3
    printf '  this worker mails is refused, and the site logs OPT-OUT NOT RECORDED.\n' >&3
  }

  if [ -n "${SMTP_HOST:-}" ]; then
    printf 'One-click unsubscribe needs the UNSUBSCRIBE_SECRET Vercel holds — the same value on both.\n' >&3
    if [ -n "$SAVED_UNSUBSCRIBE" ]; then
      printf '  Enter keeps the one saved in your Keychain; or paste Vercel'"'"'s (hidden)' >&3
    else
      printf '  Paste Vercel'"'"'s (hidden), or press Enter to send WITHOUT an unsubscribe header' >&3
    fi
    if [ "$CAN_MAKE" = yes ]; then printf ';\n  or type new to make one: ' >&3; else printf ': ' >&3; fi
    read -r -s V <&3; printf '\n' >&3
    case "${V:-}" in
      '') keep_or_none ;;
      new | NEW | New)
        if [ "$CAN_MAKE" = yes ]; then
          make_new
        else
          # Off a Mac nothing could keep it: shown nowhere, saved nowhere, and
          # Vercel would never get the value the worker mails under.
          printf '  A new secret is made only on a Mac, where it goes on the clipboard and into\n' >&3
          printf '  the Keychain. Paste the value Vercel holds instead, or leave it unset.\n' >&3
          keep_or_none
        fi
        ;;
      *) export UNSUBSCRIBE_SECRET="$V" ;;
    esac
    unset V
  elif [ -n "$SAVED_UNSUBSCRIBE" ]; then
    # Sending is off this time; carry the saved secret over all the same, so
    # remembering these answers does not delete the one value Vercel can
    # never show back. The worker adds no header without a mailbox.
    export UNSUBSCRIBE_SECRET="$SAVED_UNSUBSCRIBE"
  fi

  printf 'Slack webhook URL for the opt-out alarm (hidden; Enter to skip): ' >&3
  read -r -s V <&3; printf '\n' >&3
  [ -n "${V:-}" ] && export SLACK_WEBHOOK_URL="$V"
  unset V

  # ── Chat (optional): the one inbound route ───────────────────────────────
  # The live site's chat panel calls the worker's API port, so chat needs a
  # public address: a Tailscale Funnel on this Mac's own tailnet name,
  # https://<name>.<tailnet>.ts.net, which does not change, so Vercel's
  # AGENT_URL is set once. Three values make it: that address (read from
  # Tailscale, not typed, and not a secret), the Anthropic API key every turn
  # is billed to, and AGENT_INTERNAL_TOKEN, the bearer the site presents and
  # which Vercel must hold too. The token is made here, never typed: on the
  # clipboard for Vercel and saved at once, the unsubscribe secret's rule.
  # Tailscale's own sign-in is the Tailscale app's, and is never asked for or
  # passed here.
  SAVED_CHAT_TOKEN=""; SAVED_CHAT_KEY=""
  if have_keychain; then
    SAVED_CHAT_TOKEN=$(kc_get AGENT_INTERNAL_TOKEN) || SAVED_CHAT_TOKEN=""
    SAVED_CHAT_KEY=$(kc_get ANTHROPIC_API_KEY) || SAVED_CHAT_KEY=""
  fi
  unset CHAT_URL
  printf 'Turn on CHAT on the live site, through Tailscale Funnel on this Mac? [y/N]: ' >&3
  read -r ANSWER <&3
  case "$ANSWER" in
    [yY]*)
      if ! ts_find; then
        printf '  Tailscale is not installed. Install it from tailscale.com/download/mac, sign in,\n' >&3
        printf '  then run this again with --reconfigure. Chat stays off.\n' >&3
      elif ! V=$(ts_host); then
        printf '  Tailscale is installed but not signed in and running. Open the Tailscale app,\n' >&3
        printf '  sign in, then run this again with --reconfigure. Chat stays off.\n' >&3
      else
        export CHAT_URL="https://$V"
        printf '  This Mac'"'"'s address on the internet will be %s\n' "$CHAT_URL" >&3
      fi
      unset V
      ;;
  esac
  if [ -n "${CHAT_URL:-}" ]; then
    if [ -n "$SAVED_CHAT_KEY" ]; then
      printf '  Anthropic API key (hidden; Enter keeps the saved one): ' >&3
    else
      printf '  Anthropic API key, from console.anthropic.com (hidden): ' >&3
    fi
    read -r -s V <&3; printf '\n' >&3
    if [ -n "${V:-}" ]; then export ANTHROPIC_API_KEY="$V"
    elif [ -n "$SAVED_CHAT_KEY" ]; then export ANTHROPIC_API_KEY="$SAVED_CHAT_KEY"
    fi
    unset V
    if [ -n "$SAVED_CHAT_TOKEN" ]; then
      export AGENT_INTERNAL_TOKEN="$SAVED_CHAT_TOKEN"
      printf '  Kept the AGENT_INTERNAL_TOKEN saved in your Keychain — Vercel must hold the same one,\n' >&3
      printf '  and AGENT_URL = %s (Production). If it says anything else, change it\n' "$CHAT_URL" >&3
      printf '  there and redeploy.\n' >&3
    elif [ "$CAN_MAKE" = yes ]; then
      if [ -n "$ON_CLIPBOARD" ]; then
        printf '  The new %s is still on your clipboard. Paste it into Vercel first,\n' "$ON_CLIPBOARD" >&3
        printf '  then press Enter: ' >&3
        read -r _ <&3
      fi
      fresh=$(openssl rand -hex 32)
      if printf '%s' "$fresh" | pbcopy \
        && kc_put AGENT_INTERNAL_TOKEN "$fresh" && [ "$(kc_get AGENT_INTERNAL_TOKEN || true)" = "$fresh" ]; then
        export AGENT_INTERNAL_TOKEN="$fresh"
        ON_CLIPBOARD=AGENT_INTERNAL_TOKEN
        printf '  A new AGENT_INTERNAL_TOKEN is on your clipboard (it is not shown) and saved in your Keychain.\n' >&3
        printf '  In Vercel → Settings → Environment Variables (Production), add:\n' >&3
        printf '    AGENT_INTERNAL_TOKEN = paste the clipboard (mark it Sensitive)\n' >&3
        printf '    AGENT_URL            = %s\n' "$CHAT_URL" >&3
        printf '  then redeploy. Press Enter once both are saved: ' >&3
        read -r _ <&3
      else
        printf '' | pbcopy || true
        printf '  Could not put a token on the clipboard and in your Keychain, so chat stays off.\n' >&3
      fi
      unset fresh
    else
      printf '  Paste the AGENT_INTERNAL_TOKEN Vercel holds (hidden; Enter leaves chat off): ' >&3
      read -r -s V <&3; printf '\n' >&3
      [ -n "${V:-}" ] && export AGENT_INTERNAL_TOKEN="$V"
      unset V
    fi
  else
    # Chat off this time; carry what was saved over all the same, so
    # remembering these answers does not delete the two values that can never
    # be shown back — Vercel keeps the token Sensitive, and Anthropic shows a
    # key once. The worker is not handed the key while chat is off (below).
    [ -n "$SAVED_CHAT_TOKEN" ] && export AGENT_INTERNAL_TOKEN="$SAVED_CHAT_TOKEN"
    [ -n "$SAVED_CHAT_KEY" ] && export ANTHROPIC_API_KEY="$SAVED_CHAT_KEY"
  fi

  if have_keychain; then
    printf 'Remember these answers in your Keychain, so the next run asks nothing? [Y/n]: ' >&3
    read -r ANSWER <&3
    case "$ANSWER" in
      [nN]*)
        # Not remembering these leaves whatever was saved before in place,
        # and a run without --reconfigure reads THAT — say so, loudest where
        # it is an unsubscribe secret other than the one this run mails under.
        if kc_get DATABASE_URL >/dev/null; then
          printf '  The answers saved before stay in your Keychain, and the next run without\n' >&3
          printf '  --reconfigure uses them, not these ('"'"'%s --forget'"'"' deletes them).\n' "$0" >&3
          if [ "${UNSUBSCRIBE_SECRET:-}" != "$(kc_get UNSUBSCRIBE_SECRET || true)" ]; then
            printf '  WARNING: that includes a different UNSUBSCRIBE_SECRET from this run'"'"'s, so\n' >&3
            printf '  the unsubscribe links of one run or the other will not verify on the site.\n' >&3
          fi
        fi
        ;;
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

# ── Chat: the tunnel, before the summary says it is on ───────────────────────
# The worker's API is the port after its health port (apps/agent/src/
# worker.ts). Only that port is funnelled: it answers /internal/* to the
# bearer alone, and /livez and /readyz, which say nothing usable.
API_PORT=$(( ${AGENT_PORT:-3001} + 1 ))
CHAT=no; CHAT_WHY=""
if [ -n "${CHAT_URL:-}" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    CHAT_WHY="no Anthropic API key was given ('$0 --reconfigure' to add one)"
  elif [ -z "${AGENT_INTERNAL_TOKEN:-}" ]; then
    CHAT_WHY="no AGENT_INTERNAL_TOKEN ('$0 --reconfigure' to make one)"
  elif ! ts_find; then
    CHAT_WHY="Tailscale is not installed: install it from tailscale.com/download/mac and sign in"
  elif ! CHAT_HOST=$(ts_host); then
    CHAT_WHY="Tailscale is not signed in and running on this Mac: open the Tailscale app and sign in"
  elif [ "https://$CHAT_HOST" != "$CHAT_URL" ]; then
    # Vercel calls the address it was given; a Funnel on another name would
    # be a chat panel calling nobody while this said ON.
    CHAT_WHY="this Mac's Tailscale address is now https://$CHAT_HOST, not $CHAT_URL — set AGENT_URL to it in Vercel, redeploy, and run '$0 --reconfigure'"
  else
    # --bg: Tailscale keeps the Funnel itself, so nothing is left running
    # here. Pointing it again at the same port is a no-op. The first time,
    # Tailscale prints a link to approve Funnel for the tailnet and waits.
    FUNNEL_LOG="$(mktemp -t agency-funnel.XXXXXX)"
    if ts_deadline 20 "$FUNNEL_LOG" funnel --bg "http://127.0.0.1:$API_PORT" \
      && ts_funnel_serving "$CHAT_HOST" "$API_PORT"; then
      CHAT=yes
    else
      echo "Tailscale Funnel did not start — the last lines it wrote:" >&2
      tail -n 8 "$FUNNEL_LOG" >&2 || true
      CHAT_WHY="Tailscale Funnel did not start (if it printed a link above, open it, approve Funnel for your tailnet, and run this again)"
    fi
    rm -f "$FUNNEL_LOG"
  fi
fi
# With chat off, a Funnel an earlier run pointed at this port is closed: the
# port would answer the internet for a worker holding a token nobody has.
if [ "$CHAT" != yes ] && ts_find && OPEN_HOST=$(ts_host) && ts_funnel_serving "$OPEN_HOST" "$API_PORT"; then
  if ts_deadline 20 /dev/null funnel "http://127.0.0.1:$API_PORT" off && ! ts_funnel_serving "$OPEN_HOST" "$API_PORT"; then
    echo "Closed the Tailscale Funnel an earlier run left on this worker's port."
  else
    echo "A Tailscale Funnel an earlier run opened still points at this worker's port;" >&2
    echo "'tailscale funnel reset' closes it." >&2
  fi
fi

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
if [ "$CHAT" = yes ]; then
  echo "  chat:     ON  — the live site reaches this Mac at $CHAT_URL"
  echo "            (Tailscale Funnel), and every turn is billed to your Anthropic"
  echo "            API key. Vercel needs AGENT_URL=$CHAT_URL and the same"
  echo "            AGENT_INTERNAL_TOKEN. The Funnel stays open when this window"
  echo "            closes, answering an error until the worker runs again; a run"
  echo "            with chat off, or 'tailscale funnel reset', closes it."
elif [ -n "${CHAT_URL:-}" ]; then
  echo "  chat:     OFF — $CHAT_WHY."
else
  echo "  chat:     OFF — no inbound route. The site's chat panel says no worker"
  echo "            is connected, which is true."
fi
echo
echo "  The worker logs its own verdict as 'outreach: <mode>' and"
echo "  'sms: dovesoft on|off' at boot. If that disagrees with this, trust it."
echo "  Closing this window stops it; queued mail waits for the next run."
echo

# AGENT_INTERNAL_TOKEN is required by the worker's schema. With chat on it is
# the saved one Vercel holds; with no tunnel nothing ever presents it — the
# web app only sends it when it calls /internal/*, which it cannot reach — so
# a fresh random value per run is correct, a shared secret with nobody. And
# with chat off the worker is not handed an Anthropic key at all.
if [ "$CHAT" = yes ]; then
  WORKER_TOKEN="$AGENT_INTERNAL_TOKEN"
  # Haiku unless told otherwise: about an eighth of the default model's price.
  export AGENT_MODEL="${AGENT_MODEL:-claude-haiku-4-5}"
else
  WORKER_TOKEN="$(openssl rand -base64 32)"
  unset ANTHROPIC_API_KEY
fi
AGENT_INTERNAL_TOKEN="$WORKER_TOKEN" \
  NODE_ENV=production \
  AGENT_BIND=127.0.0.1 \
  exec node_modules/.bin/tsx apps/agent/src/index.ts
