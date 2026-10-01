#!/usr/bin/env bash
# Production, from GitHub Actions only (.github/workflows/production.yml).
#
#   tools/production.sh status    which migrations production has applied
#   tools/production.sh migrate   apply what is pending, then status
#   tools/production.sh deploy    build and deploy this checkout to Vercel prod
#   tools/production.sh release   migrate, THEN deploy, then check /api/health
#                                 reports this checkout's migration — the order
#                                 DEPLOYING.md requires ("migrate FIRST")
#
# Credentials come from the workflow's secrets and are never echoed (§2.3):
#   VERCEL_TOKEN               deploy and release; also how the database URL
#                              is found when the next one is unset
#   PRODUCTION_DATABASE_URL    optional: Neon's DIRECT string. Without it the
#                              URL is read from the Vercel project's own
#                              production environment (tools/production-env.mjs)
#   VERCEL_ORG_ID + VERCEL_PROJECT_ID, or VERCEL_TEAM    optional; without
#                              them the project `agency-os` is linked on the
#                              token's default team
#
# No `set -x`, ever: it would print every expanded credential.
set -euo pipefail

ACTION=${1:-status}
SITE=${PRODUCTION_URL:-https://myagencyos.in}
PROJECT_NAME=agency-os
VERCEL=(npx --yes vercel@62.1.0)
PULLED=.vercel/.env.production.local
export VERCEL_TELEMETRY_DISABLED=1

die() {
  echo "::error::$*"
  exit 1
}

pulled=false
vercel_pull() {
  $pulled && return 0
  [ -n "${VERCEL_TOKEN:-}" ] || die "The VERCEL_TOKEN secret is not set."
  if [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ]; then
    # The CLI refuses one of the pair without the other.
    unset VERCEL_ORG_ID VERCEL_PROJECT_ID
    local team=()
    [ -n "${VERCEL_TEAM:-}" ] && team=(--team "$VERCEL_TEAM")
    "${VERCEL[@]}" link --yes --project "$PROJECT_NAME" "${team[@]}" --token "$VERCEL_TOKEN" >/dev/null \
      || die "Could not link the Vercel project '$PROJECT_NAME' with this token. Set VERCEL_ORG_ID and VERCEL_PROJECT_ID (or VERCEL_TEAM)."
  fi
  "${VERCEL[@]}" pull --yes --environment=production --token "$VERCEL_TOKEN" >/dev/null
  node tools/production-env.mjs mask "$PULLED"
  pulled=true
}

DB_FILE=
database_url() {
  [ -n "$DB_FILE" ] && return 0
  if [ -z "${PRODUCTION_DATABASE_URL:-}" ]; then
    vercel_pull
  fi
  DB_FILE=$(mktemp "${RUNNER_TEMP:-/tmp}/db.XXXXXX")
  node tools/production-env.mjs database-url "$PULLED" "$DB_FILE"
}

built=false
db() {
  database_url
  # CI's own postgres16 job runs the compiled CLI the same way.
  $built || { npx tsc --build; built=true; }
  DATABASE_URL=$(cat "$DB_FILE") NODE_ENV=production node packages/db/dist/cli.js "$@"
}

migrate() {
  db up
  db status
}

expected_migration() {
  sed -n "s/^export const EXPECTED_MIGRATION = '\([0-9]*\)'.*/\1/p" packages/db/src/schema-version.ts
}

deploy() {
  vercel_pull
  "${VERCEL[@]}" build --prod --token "$VERCEL_TOKEN"
  # DEPLOYING.md §4a: a build can trace an env file into the output. A CI
  # checkout has none but .env.example; the pulled file lives in .vercel/ and
  # is read into the build's environment, not traced. Proved here, not assumed.
  local traced
  traced=$(grep -rhoE '"[^"]*\.env(\.[A-Za-z]+)*"' .vercel/output/functions --include='.vc-config.json' 2>/dev/null \
    | grep -vE '\.env\.example"' | sort -u || true)
  [ -z "$traced" ] || die "The build output references an env file other than .env.example; not deploying."
  [ -z "$(find .vercel/output -name '.env*' ! -name '.env.example' -print -quit)" ] \
    || die "The build output contains an env file; not deploying."
  rm -f "$PULLED"
  "${VERCEL[@]}" deploy --prebuilt --prod --archive=tgz --token "$VERCEL_TOKEN"
}

verify() {
  local want body
  want=$(expected_migration)
  [ -n "$want" ] || die "Could not read EXPECTED_MIGRATION."
  for _ in $(seq 1 30); do
    body=$(curl -fsS --max-time 15 "$SITE/api/health?strict=1" || true)
    if node -e '
      const h = JSON.parse(process.argv[1] || "{}"), want = process.argv[2]
      process.exit(h.database === "ok" && h.schema?.expected === want && h.schema?.applied === want ? 0 : 1)
    ' "$body" "$want" 2>/dev/null; then
      echo "live: $SITE reports schema $want applied and expected"
      return 0
    fi
    sleep 10
  done
  echo "last answer: ${body:-none}"
  die "$SITE did not report migration $want within five minutes."
}

case "$ACTION" in
  status) db status ;;
  migrate) migrate ;;
  deploy) deploy ;;
  release)
    migrate
    deploy
    verify
    ;;
  verify) verify ;;
  *) die "unknown action: $ACTION" ;;
esac
