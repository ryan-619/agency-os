#!/usr/bin/env bash
#
# Ask a REMOTE database what it actually is, and print only answers that are
# safe to paste into a chat.
#
# This exists because of a gap that showed up the first time production needed
# a migration applied by somebody other than the person deploying.
#
# §2.3 says no credential reaches a source file, a log line, or an assistant's
# context window, so the assistant cannot connect to production and cannot
# confirm that a migration landed. But deploying code that assumes a column
# the database does not have is exactly the failure that takes a working
# product down — so "probably applied" is not good enough either.
#
# So: you run this, and paste the output. Every line of it is a fact about
# SCHEMA, never about data and never about the connection string. Read the
# queries below — there is no row content in any of them.
#
#   ./tools/remote-status.sh
#
# Read-only. It opens a connection, runs SELECTs, and closes it. There is no
# code path here that writes.

set -euo pipefail
cd "$(dirname "$0")/.."

export PATH=/usr/local/bin:$PATH

# Same terminal requirement as remote-setup.sh, for the same reason: the
# prompt is hidden, which needs a real tty to read from. Opening it is the
# test — checking the permission bits passes in places where the open then
# fails with "Device not configured".
if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  echo "This script needs a terminal." >&2
  echo >&2
  echo "It asks for the connection string at a HIDDEN prompt so the credential" >&2
  echo "never reaches a file, a log, an argument list or shell history (§2.3)." >&2
  echo "Run it in a Terminal tab, not through a tool, a pipe, or CI." >&2
  exit 1
fi

printf 'Neon connection string (pooled is fine here): ' >&3
read -r -s DB <&3
printf '\n' >&3
exec 3>&-

if [ -z "${DB:-}" ]; then
  echo "Nothing entered. Stopping." >&2
  exit 1
fi
case "$DB" in
  postgres://*|postgresql://*) ;;
  *) echo "That does not look like a postgres:// connection string. Stopping." >&2; exit 1 ;;
esac

# Pooled is deliberately ALLOWED here, unlike remote-setup.sh. Every query
# below is a single self-contained statement, so it does not care whether the
# session survives between statements — and refusing the string somebody
# already has in their clipboard, for a read-only check, is friction that buys
# nothing.

echo
echo "── Migrations ─────────────────────────────────────────────────────"
DATABASE_URL="$DB" npm run --silent db:migrate -- status

echo
echo "── Schema facts ───────────────────────────────────────────────────"
DATABASE_URL="$DB" node -e '
const { Client } = require("pg");

// Every query is about the SHAPE of the database. information_schema and
// pg_constraint describe columns and constraints; the only counts taken are
// counts, never the rows themselves. Nothing here can print a lead, a
// message, an email address or a secret.
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const col = await c.query(`
    select column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = $1 and column_name = $2`, ["touches", "reply_kind"]);
  console.log("  touches.reply_kind:",
    col.rows.length
      ? col.rows[0].data_type + ", nullable=" + col.rows[0].is_nullable + "   <- 0017 is applied"
      : "MISSING   <- 0017 is NOT applied, do not deploy");

  const cons = await c.query(`
    select conname from pg_constraint
     where conrelid = to_regclass($1) and conname = any($2)
     order by conname`,
    ["touches", ["touches_reply_kind_is_known", "touches_reply_kind_is_inbound_only"]]);
  console.log("  its CHECK constraints:", cons.rows.map(r => r.conname).join(", ") || "NONE");

  const idx = await c.query(`
    select indexname from pg_indexes
     where schemaname = current_schema() and indexname = $1`,
    ["touches_org_reply_kind_idx"]);
  console.log("  its index:", idx.rows.length ? idx.rows[0].indexname : "MISSING");

  // 0018 must land BEFORE the code that needs it: findings.scored is the
  // first column a page reads (every company page), and the dashboard,
  // /inbox, /tasks and /contacts read tables and columns that only 0018
  // creates. Code one migration ahead boots, serves /signin, and 500s on
  // every one of those pages.
  const scored = await c.query(`
    select data_type, is_nullable
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = $1 and column_name = $2`, ["findings", "scored"]);
  console.log("  findings.scored:",
    scored.rows.length
      ? scored.rows[0].data_type + ", nullable=" + scored.rows[0].is_nullable + "   <- 0018 is applied"
      : "MISSING   <- 0018 is NOT applied, do not deploy");

  const t18 = await c.query(`
    select t, to_regclass(t) is not null as present
      from unnest($1::text[]) as t order by t`,
    [["notes", "proposal_shares", "tasks", "worker_heartbeats"]]);
  console.log("  0018 tables:", t18.rows.map(r => r.t + (r.present ? "" : " MISSING")).join(", "));

  // 0019 the same way: touches.template_id is read by the send path for
  // every message (sendFactsFor), so code ahead of it fails to send at all,
  // and /settings/templates reads message_templates.
  const tpl = await c.query(`
    select data_type, is_nullable
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = $1 and column_name = $2`, ["touches", "template_id"]);
  console.log("  touches.template_id:",
    tpl.rows.length
      ? tpl.rows[0].data_type + ", nullable=" + tpl.rows[0].is_nullable + "   <- 0019 is applied"
      : "MISSING   <- 0019 is NOT applied, do not deploy");
  // A parameter, never a quoted literal: this script is one single-quoted
  // bash string, so a quote here ends it, and the SQL arrived unquoted.
  const t19 = await c.query("select to_regclass($1) is not null as present", ["message_templates"]);
  console.log("  0019 table: message_templates" + (t19.rows[0].present ? "" : " MISSING"));

  // 0020: Settings → Assistant reads assistant_settings, and so does the
  // morning-brief check the worker runs every minute.
  const t20 = await c.query("select to_regclass($1) is not null as present", ["assistant_settings"]);
  console.log("  0020 table: assistant_settings" +
    (t20.rows[0].present ? "   <- 0020 is applied" : " MISSING   <- 0020 is NOT applied, do not deploy"));

  // 0021: what a company is recorded as (industry, city, the source of its
  // headcount) and one active ICP per org.
  const c21 = await c.query(`
    select 1 from information_schema.columns
     where table_schema = current_schema() and table_name = $1 and column_name = $2`, ["companies", "headcount_source"]);
  console.log("  companies.headcount_source:" +
    (c21.rows.length ? "   <- 0021 is applied" : " MISSING   <- 0021 is NOT applied, do not deploy"));

  // A count and an age, like the users count below: never a row. /api/health
  // already publishes the same age as worker.ageSeconds.
  if (t18.rows.find(r => r.t === "worker_heartbeats" && r.present)) {
    const hb = await c.query(`
      select count(*)::int n,
             extract(epoch from now() - max(last_tick_at))::int age
        from worker_heartbeats`);
    console.log("  worker heartbeats:", hb.rows[0].n,
      hb.rows[0].n === 0
        ? "<- no worker has written one; none runs against this database, or it predates 0018"
        : "(newest " + hb.rows[0].age + " s ago)");
  }

  // 0016, because it is the other migration production needed recently and a
  // half-applied pair is worth seeing rather than guessing at.
  const sup = await c.query(`
    select column_name from information_schema.columns
     where table_schema = current_schema() and table_name = $1
     order by column_name`, ["suppressions"]);
  console.log("  suppressions columns:", sup.rows.map(r => r.column_name).join(", ") || "TABLE MISSING");

  const n = await c.query("select count(*)::int n from information_schema.tables where table_schema = current_schema()");
  console.log("  tables:", n.rows[0].n);

  const u = await c.query("select count(*)::int n from users");
  console.log("  users:", u.rows[0].n, u.rows[0].n === 0 ? "<- nobody can sign in; seeding did not run" : "");

  const v = await c.query("select version()");
  console.log("  server:", v.rows[0].version.split(" on ")[0]);

  await c.end();
})().catch(e => {
  // The message only. A driver error can carry the DSN (§2.3).
  console.error("  FAILED:", e.message);
  process.exit(1);
})'

unset DB
echo
echo "All of the above is safe to paste. None of it contains the connection string."
