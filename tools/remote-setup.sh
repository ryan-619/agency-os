#!/usr/bin/env bash
#
# Migrate and seed a REMOTE database (Neon, RDS, anything) without the
# connection string touching a file, a log, an argument list, or shell history.
#
# Why this exists rather than an assistant just running the migration:
# §2.3 says no credential is written to a source file, a log line, or an
# agent's context window. A connection string carries a password, so it is
# read from a hidden prompt into this process's environment and nowhere else.
# `vercel env pull` cannot supply it either — Vercel returns the literal
# string "[SENSITIVE]" for variables marked sensitive, which everything the
# Neon integration creates is.
#
#   ./tools/remote-setup.sh
#
# Use the DIRECT (unpooled) connection string, not the pooled one. Neon's
# pooled endpoint is PgBouncer in transaction mode; DDL and the migrator's
# bookkeeping want a plain session. In the Vercel dashboard that is
# DATABASE_URL_UNPOOLED; in the Neon console it is the connection string with
# "Pooled connection" switched OFF (its host has no "-pooler").

set -euo pipefail
cd "$(dirname "$0")/.."

export PATH=/usr/local/bin:$PATH

printf 'Neon DIRECT (unpooled) connection string: '
# -s: no echo. Nothing is printed, so nothing lands in a screenshot either.
read -r -s DB
printf '\n'

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
    echo
    echo "That is the POOLED endpoint (its host contains '-pooler')." >&2
    echo "Migrations want the direct one — pooled connections are PgBouncer in" >&2
    echo "transaction mode and do not hold session state. Stopping." >&2
    exit 1
    ;;
esac

OWNER="${SEED_OWNER_EMAIL:-}"
if [ -z "$OWNER" ]; then
  printf 'Owner email (the only account that will be able to sign in): '
  read -r OWNER
fi

echo
echo "── Building packages ──────────────────────────────────────────────"
npx tsc --build

echo
echo "── Applying migrations ────────────────────────────────────────────"
# The CLI prints host:port/db via safeTarget() and never the DSN.
DATABASE_URL="$DB" npm run db:migrate

echo
echo "── Seeding the org, owner and ICP ─────────────────────────────────"
DATABASE_URL="$DB" \
  SEED_ORG_NAME="${SEED_ORG_NAME:-Agency}" \
  SEED_OWNER_EMAIL="$OWNER" \
  SEED_OWNER_NAME="${SEED_OWNER_NAME:-Owner}" \
  npm run db:seed

echo
echo "── Verifying ──────────────────────────────────────────────────────"
DATABASE_URL="$DB" node -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const v = await c.query("select version()");
  console.log("  server:", v.rows[0].version.split(" on ")[0]);
  const ssl = await c.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()");
  console.log("  TLS in use:", ssl.rows[0] ? ssl.rows[0].ssl : "unknown");
  const t = await c.query("select count(*)::int n from information_schema.tables where table_schema = current_schema()");
  console.log("  tables:", t.rows[0].n);
  const u = await c.query("select email, role from users");
  console.log("  users:", u.rows.map(r => r.email + " (" + r.role + ")").join(", ") || "NONE — seeding did not run");
  const co = await c.query("select count(*)::int n from companies");
  console.log("  seeded companies:", co.rows[0].n);
  await c.end();
})().catch(e => { console.error("  FAILED:", e.message); process.exit(1) })'

unset DB
echo
echo "Done. Tell the assistant, and it will redeploy and verify sign-in."
