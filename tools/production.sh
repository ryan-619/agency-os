#!/usr/bin/env bash
# Production, from GitHub Actions only (.github/workflows/production.yml).
#
#   tools/production.sh status    which migrations production has applied
#   tools/production.sh migrate   apply what is pending, then status
#   tools/production.sh deploy    build and deploy this checkout to Vercel prod
#   tools/production.sh release   migrate, THEN deploy, then check /api/health
#                                 reports this checkout's migration — the order
#                                 DEPLOYING.md requires ("migrate FIRST"). With
#                                 no PRODUCTION_DATABASE_URL, Vercel builds the
#                                 checkout and the BUILD migrates first
#                                 (tools/vercel-build-migrate.mjs)
#
# Credentials come from the workflow's secrets and are never echoed (§2.3):
#   VERCEL_TOKEN               deploy and release
#   PRODUCTION_DATABASE_URL    optional: Neon's DIRECT string. Without it,
#                              `release` lets the Vercel build migrate, with
#                              the project's own (Sensitive) database URL, and
#                              `migrate` reads it from `vercel pull`, which
#                              only works where that variable is NOT Sensitive
#   VERCEL_ORG_ID + VERCEL_PROJECT_ID, or VERCEL_TEAM    optional; without
#                              them the project `agency-os` is found under
#                              every scope the token reaches
#                              (tools/vercel-project.mjs)
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

vercel_ids() {
  [ -n "${VERCEL_TOKEN:-}" ] || die "The VERCEL_TOKEN secret is not set."
  if [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ]; then
    # Found through the API rather than `vercel link --yes`, which asks for
    # the token's user first and fails for a token scoped to a team. The CLI
    # reads the pair from the environment and refuses one without the other.
    local ids
    ids=$(node tools/vercel-project.mjs "$PROJECT_NAME" ${VERCEL_TEAM:+"$VERCEL_TEAM"}) \
      || die "Could not find the Vercel project '$PROJECT_NAME' with this token (the lines above say why)."
    VERCEL_ORG_ID=$(sed -n 's/^VERCEL_ORG_ID=//p' <<<"$ids")
    VERCEL_PROJECT_ID=$(sed -n 's/^VERCEL_PROJECT_ID=//p' <<<"$ids")
    export VERCEL_ORG_ID VERCEL_PROJECT_ID
  fi
}

pulled=false
vercel_pull() {
  $pulled && return 0
  vercel_ids
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

# A REMOTE build: Vercel builds this checkout with the project's own
# production variables — the Sensitive database URL included, which no pull
# returns — and `AGENCY_MIGRATE_ON_BUILD=1` makes that build apply pending
# migrations before `next build` (tools/vercel-build-migrate.mjs). A failed
# migration fails the build, so nothing is deployed ahead of its schema.
deploy_remote_migrating() {
  vercel_ids
  "${VERCEL[@]}" deploy --prod --yes --logs --archive=tgz \
    --build-env AGENCY_MIGRATE_ON_BUILD=1 --token "$VERCEL_TOKEN"
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

# What production says it has applied, from its own health check — needs no
# credential at all.
health_status() {
  curl -fsS --max-time 15 "$SITE/api/health" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const h = JSON.parse(s)
      console.log(`${process.argv[1]}: database ${h.database}, schema ${h.schema?.state} (applied ${h.schema?.applied}, expected ${h.schema?.expected})`)
    })' "$SITE"
}

case "$ACTION" in
  status)
    if [ -n "${PRODUCTION_DATABASE_URL:-}" ]; then db status; else health_status; fi
    ;;
  migrate) migrate ;;
  deploy) deploy ;;
  release)
    if [ -n "${PRODUCTION_DATABASE_URL:-}" ]; then
      # Migrate from here, then deploy what was built here.
      migrate
      deploy
    else
      # The database URL is Vercel's alone: the build migrates, then deploys.
      deploy_remote_migrating
    fi
    verify
    ;;
  verify) verify ;;
  *) die "unknown action: $ACTION" ;;
esac
