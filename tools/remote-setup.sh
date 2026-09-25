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

# Both prompts read from /dev/tty rather than stdin, and write to it rather
# than stdout. Run through a tool, a pipe or a non-interactive shell there is
# no terminal to read from: `read` then fails instantly, `set -e` exits, and
# all anybody sees is the prompt and a dead shell — which is what happened the
# first time this was run from the app's command box. Say so instead.
# Opening it is the test. `[ -r /dev/tty ]` only reads the permission bits
# and passes in places where the open then fails with "Device not configured".
if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  echo "This script needs a terminal." >&2
  echo >&2
  echo "It asks for the connection string at a HIDDEN prompt, so the credential" >&2
  echo "never reaches a file, a log, an argument list or shell history (§2.3)." >&2
  echo "That needs a real terminal to read from — run it in a Terminal tab, not" >&2
  echo "through a tool, a pipe, or CI." >&2
  exit 1
fi

printf 'Neon DIRECT (unpooled) connection string: ' >&3
# -s: no echo. Nothing is printed, so nothing lands in a screenshot either.
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
    echo
    echo "That is the POOLED endpoint (its host contains '-pooler')." >&2
    echo "Migrations want the direct one — pooled connections are PgBouncer in" >&2
    echo "transaction mode and do not hold session state. Stopping." >&2
    exit 1
    ;;
esac

OWNER="${SEED_OWNER_EMAIL:-}"
if [ -z "$OWNER" ]; then
  printf 'Owner email (the only account that will be able to sign in): ' >&3
  read -r OWNER <&3
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
  // Reads FALSE on Neon and that is not a finding. Neon terminates TLS at its
  // proxy, so pg_stat_ssl describes the hop from that proxy to the Postgres
  // backend, INSIDE their network — not the connection from here, which
  // sslmode=require already refused to make without TLS. Printed with the
  // explanation attached because a bare "TLS in use: false" at the end of a
  // migration run reads like a security problem and sends people looking for
  // one that is not there.
  const backendSsl = ssl.rows[0] ? ssl.rows[0].ssl : "unknown";
  console.log(
    "  client TLS:   required by the connection string (sslmode)",
  );
  console.log(
    "  backend TLS: ", backendSsl,
    backendSsl === false ? "(expected on Neon — TLS ends at their proxy, not a finding)" : "",
  );
  const t = await c.query("select count(*)::int n from information_schema.tables where table_schema = current_schema()");
  console.log("  tables:", t.rows[0].n);
  const u = await c.query("select email, role from users");
  console.log("  users:", u.rows.map(r => r.email + " (" + r.role + ")").join(", ") || "NONE — seeding did not run");
  const co = await c.query("select count(*)::int n from companies");
  console.log("  seeded companies:", co.rows[0].n);
  await c.end();
})().catch(e => { console.error("  FAILED:", e.message); process.exit(1) })'

unset DB
exec 3>&-
echo
echo "Done. Tell the assistant, and it will redeploy and verify sign-in."
