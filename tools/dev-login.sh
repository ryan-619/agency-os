#!/usr/bin/env bash
#
# Get a sign-in link for the LOCAL instance, without a mailbox.
#
#   ./tools/dev-login.sh                  # the seeded owner
#   ./tools/dev-login.sh you@example.com  # anyone already on the team
#
# Sign-in here is a magic link and there is no password to hand out — which is
# correct, and inconvenient the moment you are running against a local SMTP
# catcher rather than a real inbox. This asks the app for a link exactly as the
# form does (same CSRF flow, same route, same membership check) and then reads
# the result out of the catcher's log.
#
# It cannot mint a link for an address that is not on the team: the app returns
# the same response either way and simply never sends one, which is the
# property the sign-in flow is built around. If nothing appears, that is the
# most likely reason.
#
# Needs, all local: the dev server, and the SMTP catcher on 1025 writing to
# .dev-mail/links.txt.

set -uo pipefail
cd "$(dirname "$0")/.."
export PATH=/usr/local/bin:$PATH

BASE="${BASE_URL:-http://localhost:8052}"
EMAIL="${1:-owner@agency.test}"
LINKS="$PWD/.dev-mail/links.txt"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# Make sure the log exists before anything counts its lines: a `< missing-file`
# redirect is the SHELL failing, so `2>/dev/null` on the command does not
# silence it and the run starts with an error it does not deserve.
mkdir -p "$(dirname "$LINKS")"
: >> "$LINKS"

if ! curl -sf --max-time 5 -o /dev/null "$BASE/api/health"; then
  echo "No dev server answering at $BASE." >&2
  echo "Start it first, then run this again." >&2
  exit 1
fi
if ! nc -z 127.0.0.1 1025 2>/dev/null; then
  echo "No SMTP catcher on 127.0.0.1:1025 — the link has nowhere to be caught." >&2
  echo "Start it with:  OUT=\"\$PWD/.dev-mail/links.txt\" node .dev-mail/catcher.mjs &" >&2
  exit 1
fi

BEFORE=$(wc -l < "$LINKS" 2>/dev/null || echo 0)

CSRF=$(curl -s -c "$JAR" --max-time 15 "$BASE/api/auth/csrf" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrfToken"])' 2>/dev/null)
if [ -z "${CSRF:-}" ]; then
  echo "Could not get a CSRF token from $BASE. Is the server healthy?" >&2
  exit 1
fi

curl -s -b "$JAR" -c "$JAR" --max-time 30 -o /dev/null \
  -X POST "$BASE/api/auth/signin/nodemailer" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$EMAIL" \
  --data-urlencode "callbackUrl=$BASE/"

# The send happens inside the request, but the catcher writes from its own
# process, so give it a moment to land rather than racing it.
for _ in $(seq 1 20); do
  AFTER=$(wc -l < "$LINKS" 2>/dev/null || echo 0)
  [ "$AFTER" -gt "$BEFORE" ] && break
  sleep 0.5
done

LINK=$(grep -E '^https?://' "$LINKS" 2>/dev/null | tail -1)
if [ -z "${LINK:-}" ] || [ "$AFTER" -le "$BEFORE" ]; then
  echo "No link arrived for $EMAIL." >&2
  echo "Either that address is not on the team — the app deliberately gives the" >&2
  echo "same answer either way and just does not send — or the catcher is not" >&2
  echo "receiving. Check .dev-mail/catcher.log." >&2
  exit 1
fi

echo
echo "Signed-in link for $EMAIL — valid 15 minutes, usable once:"
echo
echo "  $LINK"
echo
