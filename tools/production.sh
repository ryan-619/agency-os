#!/usr/bin/env bash
# Production, from GitHub Actions only (.github/workflows/production.yml).
#
#   tools/production.sh status    which migrations production has applied
#   tools/production.sh migrate   apply what is pending, then status
#   tools/production.sh deploy    build and deploy this checkout to Vercel prod
#   tools/production.sh worker    deploy apps/agent to Fly.io (fly.toml) and
#                                 point the web app at it — refused until
#                                 production has this checkout's migration
#                                 (run `release` first)
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
  # NEXT_ENABLE_ADAPTER=0: Vercel's remote builders switch @vercel/next's
  # new adapter on, and with this app's standalone output its
  # onBuildComplete looks for an apps/web/.next/next-server.js.nft.json the
  # build never wrote, failing every remote build after the migration step.
  # A `vercel build` run anywhere else takes the classic path, which works.
  "${VERCEL[@]}" deploy --prod --yes --logs --archive=tgz \
    --build-env AGENCY_MIGRATE_ON_BUILD=1 --build-env NEXT_ENABLE_ADAPTER=0 --token "$VERCEL_TOKEN"
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

# --- the worker, on Fly.io -------------------------------------------------
#
# One app, ONE machine that never stops (fly.toml's header says why), its
# secrets imported from this run's environment over stdin and never echoed,
# then the web app pointed at it.
#
# The internal token is generated here, and a run that stages a new one on
# Fly sets it on Vercel and redeploys the web app in the same run. A run cut
# off part-way — Fly re-tokened and Vercel not set, or Vercel set and the web
# app never redeployed — must not read as wired to the next one, which only
# saw that the names existed and went green with every web call to the
# worker refused (review round 6, [10]). So the LAST step of a complete
# wiring records a marker on Vercel: the Fly app and Fly's own digest of the
# token it holds, neither of them secret. A run that does not find exactly
# that marker, beside both names, rotates the token and wires both sides
# again; one that does keeps the token.

APP=
fly_app() {
  [ -n "${FLY_API_TOKEN:-}" ] || die "The FLY_API_TOKEN secret is not set (an ORG token: fly.io → Tokens)."
  export FLY_API_TOKEN
  local want existing first_error
  want=$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)
  existing=$(flyctl apps list --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const want = process.argv[1]
      const names = (JSON.parse(s || "[]") || []).map((a) => a.Name ?? a.name ?? a.ID ?? a.id).filter(Boolean)
      const hit = names.find((n) => n === want) ?? names.find((n) => n.startsWith(want + "-"))
      if (hit) console.log(hit)
    })' "$want") || die "Could not list Fly apps with this token."
  if [ -n "$existing" ]; then
    APP=$existing
    echo "fly: app $APP"
    return 0
  fi
  if first_error=$(flyctl apps create "$want" --org "${FLY_ORG:-personal}" 2>&1); then
    APP=$want
  else
    # Fly app names are global: somebody else may hold this one.
    APP="$want-$(openssl rand -hex 3)"
    flyctl apps create "$APP" --org "${FLY_ORG:-personal}" >/dev/null 2>&1 || {
      echo "first attempt: $first_error"
      die "Could not create a Fly app. FLY_API_TOKEN must be an ORG token, and the org needs a payment method."
    }
  fi
  echo "fly: created app $APP"
}

# "<name> <digest>" per secret on the app. The digest is Fly's own hash of
# the value — never the value, which Fly does not return to anybody.
fly_secrets() {
  flyctl secrets list --app "$APP" --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      for (const x of JSON.parse(s || "[]") || []) console.log(`${x.Name ?? x.name} ${x.Digest ?? x.digest ?? ""}`)
    })'
}

# Fly's digest of AGENT_INTERNAL_TOKEN, empty when it has none. Called in a
# command substitution, so it fails rather than dying: `die` there would
# print its sentence into the caller's variable.
fly_token_digest() {
  local secrets
  secrets=$(fly_secrets) || return 1
  sed -n 's/^AGENT_INTERNAL_TOKEN \([^ ]*\)$/\1/p' <<<"$secrets"
}

# Exit 0 yes, 1 no — and an API error STOPS the run, never reads as "no".
vercel_env() {
  local rc=0
  node tools/vercel-env.mjs "$@" || rc=$?
  case $rc in
    0 | 1) return $rc ;;
    *) die "Could not read the Vercel project's variables (the line above says why); nothing was changed." ;;
  esac
}

# The worker deploys this checkout, and a re-wiring redeploys the web app
# from it too; neither may run ahead of its schema (DEPLOYING.md, "migrate
# FIRST"). Asked of the database itself, before anything is created or
# deployed. Migrating stays `release`'s job, so there is one place that
# migrates (review round 6, [11] and [17]).
schema_ready() {
  local want out
  want=$(expected_migration)
  [ -n "$want" ] || die "Could not read EXPECTED_MIGRATION."
  out=$(mktemp "${RUNNER_TEMP:-/tmp}/status.XXXXXX")
  db status >"$out" || die "Could not read which migrations production has applied."
  cat "$out"
  grep -qE "^[[:space:]]*\[x\] ${want}_" "$out" \
    || die "Production has not applied migration $want, which this checkout expects. Run the 'release' action from this ref first — it migrates, then deploys the web app — and then 'worker'. Nothing was deployed."
  echo "schema: production has migration $want applied, as this checkout expects"
}

MARKER=AGENT_INTERNAL_TOKEN_WIRED

worker() {
  [ -n "${FLY_API_TOKEN:-}" ] || die "The FLY_API_TOKEN secret is not set (an ORG token: fly.io → Tokens)."
  database_url
  schema_ready
  fly_app
  vercel_ids
  local lines="" token="" digest
  add() { lines+="$1=$2"$'\n'; }
  add DATABASE_URL "$(cat "$DB_FILE")"
  add WEB_PUBLIC_URL "$SITE"
  local wire=true
  digest=$(fly_token_digest) || die "Could not list the Fly app's secrets."
  if [ -n "$digest" ] && vercel_env has AGENT_INTERNAL_TOKEN && vercel_env has AGENT_URL \
    && VALUE="$APP:$digest" vercel_env equals "$MARKER"; then
    wire=false
    echo "wiring: Vercel was wired to this app's current token by a run that finished; keeping it"
  else
    token=$(openssl rand -hex 32)
    echo "::add-mask::$token"
    add AGENT_INTERNAL_TOKEN "$token"
    echo "wiring: no record that both sides hold the same token; a new one goes to Fly AND Vercel in this run"
  fi
  # Everything optional, only when this run was handed it.
  local n
  for n in ANTHROPIC_API_KEY ANTHROPIC_WORKSPACE_ID AGENT_MODEL SECRETS_KEY \
    SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_SECURE MAIL_FROM \
    IMAP_HOST IMAP_PORT IMAP_USER IMAP_PASSWORD IMAP_SECURE IMAP_MAILBOX \
    SLACK_WEBHOOK_URL UNSUBSCRIBE_SECRET DOVESOFT_API_KEY DOVESOFT_ENTITY_ID; do
    if [ -n "${!n:-}" ]; then add "$n" "${!n}"; fi
  done
  printf '%s' "$lines" | flyctl secrets import --app "$APP" --stage >/dev/null
  echo "fly: secrets staged: $(printf '%s' "$lines" | cut -d= -f1 | tr '\n' ' ')"

  flyctl deploy --app "$APP" --config fly.toml --remote-only --ha=false
  flyctl scale count 1 --app "$APP" --yes >/dev/null
  worker_ready

  if $wire; then
    VALUE="https://$APP.fly.dev" node tools/vercel-env.mjs set AGENT_URL encrypted
    VALUE="$token" node tools/vercel-env.mjs set AGENT_INTERNAL_TOKEN sensitive
    # A new deployment is what picks the variables up.
    deploy
    verify
    # Last: only a run that got this far may say both sides agree.
    digest=$(fly_token_digest) || digest=
    if [ -n "$digest" ]; then
      VALUE="$APP:$digest" node tools/vercel-env.mjs set "$MARKER" encrypted
    else
      echo "::warning::Fly reported no digest for AGENT_INTERNAL_TOKEN, so the wiring could not be recorded; the next run will rotate the token and wire both sides again."
    fi
  fi
  worker_seen
}

worker_ready() {
  local code=""
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$APP.fly.dev/readyz" || true)
    if [ "$code" = 200 ]; then
      echo "worker: https://$APP.fly.dev/readyz answers 200"
      return 0
    fi
    sleep 10
  done
  die "The worker's /readyz answered ${code:-nothing} for five minutes: flyctl logs --app $APP"
}

# The web app reads the worker's heartbeat row, not its URL: "live" there is
# the proof the two share a database.
worker_seen() {
  local status=""
  for _ in $(seq 1 30); do
    status=$(curl -fsS --max-time 15 "$SITE/api/health" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { console.log(JSON.parse(s).worker?.status ?? "") } catch { console.log("") }
      })' || true)
    if [ "$status" = live ]; then
      echo "live: $SITE/api/health reports the worker live"
      return 0
    fi
    sleep 10
  done
  die "$SITE/api/health did not report the worker live within five minutes (last: ${status:-nothing})."
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
  deploy)
    deploy
    verify
    ;;
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
  worker) worker ;;
  *) die "unknown action: $ACTION" ;;
esac
