#!/usr/bin/env bash
#
# The DNS a sending domain needs, as commands you can paste.
#
# Cold outreach that is not authenticated does not reach an inbox. SPF, DKIM
# and DMARC are how a receiving server decides that mail claiming to be from
# your domain really is — and without all three, everything else in this
# product is a very well-tested way to write into a spam folder.
#
#   ./tools/mail-dns.sh
#
# It asks for the domain and prints:
#   - the DMARC record, which is entirely your choice and therefore generated
#   - `vercel dns add` commands for the records Resend gives you
#   - what to paste where, and in what order
#
# It deliberately does NOT invent your SPF and DKIM values. Resend generates
# a DKIM key per domain and its SPF include depends on the region your
# account sends from, so both are copied from Resend's dashboard verbatim.
# A guessed DKIM key is not a typo, it is a domain that silently fails
# authentication.

set -euo pipefail
cd "$(dirname "$0")/.."

if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  echo "This script needs a terminal." >&2
  exit 1
fi

printf 'Sending domain (e.g. agency.com, or outreach.agency.com): ' >&3
read -r DOMAIN <&3
printf 'Where do replies go? (an address you can read, e.g. you@gmail.com): ' >&3
read -r REPLIES <&3
exec 3>&-

DOMAIN="$(printf '%s' "$DOMAIN" | tr -d ' ' | tr 'A-Z' 'a-z')"
REPLIES="$(printf '%s' "$REPLIES" | tr -d ' ' | tr 'A-Z' 'a-z')"
[ -n "$DOMAIN" ] || { echo "No domain. Stopping." >&2; exit 1; }

cat <<EOF

────────────────────────────────────────────────────────────────────────
  Sending domain: $DOMAIN
────────────────────────────────────────────────────────────────────────

STEP 1 — add the domain to Resend
  https://resend.com/domains → Add Domain → $DOMAIN
  Resend then shows you a DKIM record and an SPF record. Leave that page
  open; you are about to copy both of them.

STEP 2 — put Resend's records into Vercel DNS
  Vercel's CLI takes them as:

    vercel dns add $DOMAIN <name> TXT "<value>"

  For the two Resend shows you, that is usually:

    # DKIM — the long key. Copy the NAME and VALUE exactly as Resend prints
    # them; the name is often "resend._domainkey" or "send._domainkey".
    vercel dns add $DOMAIN resend._domainkey TXT "<paste Resend's DKIM value>"

    # SPF — Resend tells you which include to use for your region.
    vercel dns add $DOMAIN send TXT "v=spf1 include:<Resend's include> ~all"

  Resend may also give you an MX record for bounce handling:

    vercel dns add $DOMAIN send MX feedback-smtp.<region>.amazonses.com 10

  Copy those values from Resend rather than from here. They differ per
  account and per region, and a guessed DKIM key fails silently.

STEP 3 — DMARC. This one is yours, so here it is, ready to paste:

    vercel dns add $DOMAIN _dmarc TXT "v=DMARC1; p=none; rua=mailto:$REPLIES; fo=1; adkim=r; aspf=r"

  p=none means "monitor, do not reject". Start there ALWAYS. A p=reject on
  day one, with SPF or DKIM slightly wrong, bounces every message you send
  and you find out from silence. Read the reports that arrive at
  $REPLIES for a couple of weeks, confirm everything passes, then tighten
  to p=quarantine and later p=reject.

STEP 4 — wait for Resend to verify, then point the app at it

  In Vercel → Project → Environment Variables (Production):

    MAIL_FROM   "Your Name <hello@$DOMAIN>"
    SMTP_HOST   smtp.resend.com
    SMTP_PORT   587
    SMTP_USER   resend
    SMTP_PASSWORD   <your Resend API key>

  Then redeploy. ./tools/spend.sh's sibling for mail does not exist; the
  worker logs 'outreach: send-only' or 'send-and-receive' at boot, which is
  how you tell whether it picked the settings up.

STEP 5 — warm the domain up

  A domain with no sending history that starts at fifty messages a day looks
  exactly like a compromised account. Set the campaign's dailyCap low and
  raise it:

    week 1   5/day       week 3   25/day
    week 2   15/day      week 4   40/day, if nothing is bouncing

  The cap is a campaign column, so this is a setting rather than a code
  change — but it is the difference between a domain that works in a month
  and one that is burned in a week.

VERIFYING (once the records have propagated)

    dig +short TXT _dmarc.$DOMAIN
    dig +short TXT send.$DOMAIN
    dig +short TXT resend._domainkey.$DOMAIN

  Or send one message to a personal address and read the raw headers: you
  want "spf=pass", "dkim=pass" and "dmarc=pass". Anything else is worth
  fixing before the first campaign, not after it.

────────────────────────────────────────────────────────────────────────
EOF
