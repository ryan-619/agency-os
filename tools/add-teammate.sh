#!/usr/bin/env bash
#
# Give somebody access to Agency OS.
#
# There is NO SIGNUP FLOW, by design (§1): `users.org_id` is NOT NULL with no
# default, so Auth.js's adapter cannot create a user, and the sign-in callback
# refuses any address without a row *before* any mail is sent. Access is
# therefore something an owner grants in the database, which is this script.
#
# The address is stored LOWER-CASED because it must be. @auth/core folds the
# sign-in identifier before any lookup and the drizzle adapter then matches
# `users.email` exactly, so a row written as `Priya@Agency.com` is invisible to
# the lookup — Auth.js tries to create a second user, hits the NOT NULL, and
# locks the person out with an opaque error. `users_email_is_normalised`
# rejects the un-folded form outright; this folds it before it gets there.
#
#   ./tools/add-teammate.sh
#
# Roles: 'member' (default) or 'owner'. Only an owner may edit connectors and
# the credentials behind them (§4), so hand that out deliberately.

set -euo pipefail
cd "$(dirname "$0")/.."

export PATH=/usr/local/bin:$PATH

if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  echo "This script needs a terminal — the connection string is read from a" >&2
  echo "hidden prompt so it never reaches a file or shell history (§2.3)." >&2
  exit 1
fi

printf 'DATABASE_URL (direct/unpooled): ' >&3
read -r -s DB <&3
printf '\n' >&3
[ -n "${DB:-}" ] || { echo "Nothing entered. Stopping." >&2; exit 1; }
case "$DB" in postgres://*|postgresql://*) ;; *) echo "Not a postgres:// string. Stopping." >&2; exit 1 ;; esac

printf 'Their email address: ' >&3
read -r EMAIL <&3
printf 'Their name (optional): ' >&3
read -r NAME <&3
printf "Role — 'member' or 'owner' [member]: " >&3
read -r ROLE <&3
exec 3>&-

ROLE="${ROLE:-member}"
case "$ROLE" in
  member|owner) ;;
  *) echo "Role must be 'member' or 'owner'. Stopping." >&2; exit 1 ;;
esac

# Written into the repo, not /tmp: node resolves node_modules by walking up
# from the script's own directory, so a helper in /tmp cannot find `pg`.
HELPER="./.agency-add-teammate.mjs"
trap 'rm -f "$HELPER"' EXIT
cat > "$HELPER" <<'EOF'
import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

// Folded here rather than trusted from the prompt — see the header. The CHECK
// would reject the un-folded form anyway; doing it first turns a constraint
// violation into a row.
const email = (process.env.TEAMMATE_EMAIL ?? '').trim().toLowerCase()
const name = (process.env.TEAMMATE_NAME ?? '').trim() || null
const role = process.env.TEAMMATE_ROLE ?? 'member'
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`  "${email}" does not look like an email address. Nothing was written.`)
  process.exit(1)
}

const orgs = await c.query('select id, name from orgs order by created_at limit 2')
if (orgs.rows.length === 0) { console.error('  No org exists yet — run tools/remote-setup.sh first.'); process.exit(1) }
if (orgs.rows.length > 1) { console.error('  More than one org; this script refuses to guess whose team this is.'); process.exit(1) }
const org = orgs.rows[0]

const existing = await c.query('select email, role from users where email = $1', [email])
if (existing.rows.length) {
  console.log(`  ${email} already has access to ${org.name} as ${existing.rows[0].role} — nothing to do.`)
  await c.end()
  process.exit(0)
}

await c.query(
  'insert into users (org_id, email, name, role) values ($1, $2, $3, $4)',
  [org.id, email, name, role],
)
console.log(`  added ${email} to ${org.name} as ${role}`)
console.log('')
console.log('  They sign in at the live site with a magic link — there is no password')
console.log('  and nothing to send them. Tell them to enter this address at /signin.')
await c.end()
EOF

DATABASE_URL="$DB" \
  TEAMMATE_EMAIL="$EMAIL" \
  TEAMMATE_NAME="$NAME" \
  TEAMMATE_ROLE="$ROLE" \
  node "$HELPER"

unset DB
