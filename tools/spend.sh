#!/usr/bin/env bash
#
# What the Anthropic API has actually cost, from the rows rather than an
# estimate.
#
# `chat_messages.cost_usd` is written from the SDK's own figure on every turn,
# so this is the real number and not a model of it. On a prepaid balance that
# distinction is the whole point: an estimate tells you what a month might
# cost, this tells you what the week did.
#
#   ./tools/spend.sh
#
# Reads the connection string from a hidden prompt (§2.3), like the other
# scripts here. Sums in SQL — `cost_usd` is drizzle `numeric` with no mode, so
# it arrives in JavaScript as a STRING and "0.01" + "0.02" is "0.010.02",
# which stores fine and reads as a number to nobody.

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
exec 3>&-
[ -n "${DB:-}" ] || { echo "Nothing entered. Stopping." >&2; exit 1; }
case "$DB" in postgres://*|postgresql://*) ;; *) echo "Not a postgres:// string. Stopping." >&2; exit 1 ;; esac

HELPER="./.agency-spend.mjs"
trap 'rm -f "$HELPER"' EXIT
cat > "$HELPER" <<'EOF'
import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const money = (v) => '$' + Number(v ?? 0).toFixed(4)

const total = await c.query(
  `select coalesce(sum(cost_usd::numeric), 0) spent,
          count(*) filter (where cost_usd::numeric > 0) turns
     from chat_messages`,
)
const t = total.rows[0]
console.log(`\n  all time     ${money(t.spent)} over ${t.turns} costed turn(s)`)

const days = await c.query(
  // `day` is a reserved word as a bare alias here; hence `bucket`.
  `select date_trunc('day', created_at)::date bucket,
          count(*) filter (where cost_usd::numeric > 0) turns,
          coalesce(sum(cost_usd::numeric), 0) spent
     from chat_messages
    where created_at > now() - interval '14 days'
    group by 1 order by 1 desc`,
)
if (days.rows.length) {
  console.log('\n  last 14 days')
  for (const d of days.rows) {
    console.log(`    ${d.bucket.toISOString().slice(0, 10)}  ${String(d.turns).padStart(4)} turns  ${money(d.spent)}`)
  }
}

// Per person, because on a shared balance "who is spending it" is the
// question a prepaid account actually raises.
const people = await c.query(
  `select u.email, count(*) filter (where m.cost_usd::numeric > 0) turns,
          coalesce(sum(m.cost_usd::numeric), 0) spent
     from chat_messages m
     join chat_sessions s on s.id = m.session_id
     join users u on u.id = s.user_id
    group by u.email order by 3 desc`,
)
if (people.rows.length) {
  console.log('\n  by person')
  for (const p of people.rows) {
    console.log(`    ${p.email.padEnd(32)} ${String(p.turns).padStart(4)} turns  ${money(p.spent)}`)
  }
}

const recent = await c.query(
  `select coalesce(sum(cost_usd::numeric), 0) spent
     from chat_messages where created_at > now() - interval '7 days'`,
)
const week = Number(recent.rows[0].spent ?? 0)
if (week > 0) {
  console.log(`\n  last 7 days  ${money(week)}  →  about ${money(week * 4.35)}/month at this rate`)
} else {
  console.log('\n  nothing spent in the last 7 days.')
}
console.log('')
await c.end()
EOF

DATABASE_URL="$DB" node "$HELPER"
unset DB
