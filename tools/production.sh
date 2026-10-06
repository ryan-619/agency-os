#!/usr/bin/env bash
# Production, from GitHub Actions only (.github/workflows/production.yml).
#
#   tools/production.sh status    which migrations production has applied
#   tools/production.sh migrate   apply what is pending, then status
#   tools/production.sh deploy    build and deploy this checkout to Vercel prod
#   tools/production.sh worker    deploy apps/agent to Fly.io (fly.toml) and,
#                                 when the wiring changes, set AGENT_URL and
#                                 AGENT_INTERNAL_TOKEN on Vercel — refused
#                                 until production has this checkout's
#                                 migration (run `release` first). Never runs
#                                 the Vercel CLI
#   tools/production.sh worker-web
#                                 the worker action's second job: redeploy the
#                                 web app when `worker` left a wiring of this
#                                 run waiting, record it, then check the
#                                 worker is live
#   tools/production.sh release   migrate, THEN deploy, then check /api/health
#                                 reports this checkout's migration — the order
#                                 DEPLOYING.md requires ("migrate FIRST"). With
#                                 no PRODUCTION_DATABASE_URL, Vercel builds the
#                                 checkout and the BUILD migrates first
#                                 (tools/vercel-build-migrate.mjs)
#
# `worker-web` also reads REDEPLOY, the `worker` job's one output as it
# arrived — never a secret (production.yml, and worker_web below).
#
# Credentials come from the workflow's secrets and are never echoed (§2.3):
#   VERCEL_TOKEN               deploy, release, worker and worker-web
#   PRODUCTION_DATABASE_URL    Neon's DIRECT string; optional but for
#                              `worker`. Without it, `release` lets the Vercel
#                              build migrate, with the project's own
#                              (Sensitive) database URL, and `migrate` reads
#                              it from `vercel pull`, which only works where
#                              that variable is NOT Sensitive
#   VERCEL_ORG_ID + VERCEL_PROJECT_ID, or VERCEL_TEAM    optional; without
#                              them the project `agency-os` is found under
#                              every scope the token reaches
#                              (tools/vercel-project.mjs)
#   WORKER_ONLY, below         `worker` alone: staged on Fly over stdin, and
#                              handed to no program but flyctl. `worker-web`
#                              runs in a job that is never given one
#
# No `set -x`, ever: it would print every expanded credential.
set -euo pipefail

ACTION=${1:-status}
SITE=${PRODUCTION_URL:-https://myagencyos.in}
PROJECT_NAME=agency-os

# The worker job's own secrets (.github/workflows/production.yml hands them
# to the `worker` job's script step alone). `worker` stages them on Fly over
# stdin and hands flyctl FLY_API_TOKEN; no other program this script runs
# inherits any of them — not our own helpers, which need none (review round
# 7, [6]). FLY_API_TOKEN and FLY_ORG are Fly's, so they are not staged. A
# name added to the step goes here too:
# packages/db/test/production-tooling.test.ts holds the two lists equal.
#
# What un-exporting does NOT do (review round 8, [5]): it changes what a
# child INHERITS, never what is in /proc/<pid>/environ of this shell and the
# step's shell above it — the environment each was started with — which any
# process running as the same user can read. So no un-export can keep a
# secret from the Vercel CLI, which npx installs at run time with no lockfile
# and floating transitive ranges, and whose `build` runs the whole web build.
# Only a JOB boundary can: `worker` never runs that CLI (below), and the web
# redeploy is `worker-web`'s, in a job of its own on a fresh VM that is
# handed VERCEL_* alone.
WORKER_ONLY=(FLY_API_TOKEN FLY_ORG ANTHROPIC_API_KEY ANTHROPIC_WORKSPACE_ID AGENT_MODEL SECRETS_KEY
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_SECURE MAIL_FROM
  IMAP_HOST IMAP_PORT IMAP_USER IMAP_PASSWORD IMAP_SECURE IMAP_MAILBOX
  SLACK_WEBHOOK_URL UNSUBSCRIBE_SECRET DOVESOFT_API_KEY DOVESOFT_ENTITY_ID)
# Each stays a shell variable, read where it is used, and no program this
# script starts inherits one.
export -n "${WORKER_ONLY[@]}"
# A second guard, which holds even if a later edit exports one again: the
# Vercel CLI's own command line strips them all — and in the one action whose
# job holds them, there is no Vercel CLI at all (no_vercel_cli).
STRIP=()
for n in "${WORKER_ONLY[@]}"; do STRIP+=(-u "$n"); done
VERCEL=(env "${STRIP[@]}" npx --yes vercel@62.1.0)
[ "$ACTION" != worker ] || VERCEL=(no_vercel_cli)
PULLED=.vercel/.env.production.local
export VERCEL_TELEMETRY_DISABLED=1

die() {
  echo "::error::$*"
  exit 1
}

# What every Vercel CLI call in the `worker` action reaches instead of the
# CLI: a stop, on stderr because some callers send stdout to /dev/null.
no_vercel_cli() {
  echo "::error::The worker action's job holds the worker's secrets and never runs the Vercel CLI; the web redeploy belongs to the worker-web job. This is a bug in tools/production.sh." >&2
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
  # CI's own postgres16 job runs the compiled CLI the same way. The
  # lockfile's tsc, by path, never through npx: npx installs a package from
  # the registry when it finds no local one by that name, assuming --yes in
  # CI, and the `worker` job runs no code fetched at run time.
  $built || { node_modules/.bin/tsc --build; built=true; }
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
    # No -f: a 503's body is the answer worth reading — it names the class of
    # failure and nothing more (the route reports no value), where -f printed
    # "last answer: none" for a deployment whose configuration did not parse.
    body=$(curl -sS --max-time 15 "$SITE/api/health?strict=1" || true)
    if node -e '
      const h = JSON.parse(process.argv[1] || "{}"), want = process.argv[2]
      process.exit(h.database === "ok" && h.schema?.expected === want && h.schema?.applied === want ? 0 : 1)
    ' "$body" "$want" 2>/dev/null; then
      echo "live: $SITE reports schema $want applied and expected"
      return 0
    fi
    sleep 10
  done
  echo "last answer: $(printf '%s' "${body:-none}" | head -c 600)"
  case "$body" in
    *'"config":"invalid"'*)
      echo "This deployment's environment variables do not parse. Its runtime log (Vercel → Logs)" >&2
      echo "names the variable after 'Invalid environment configuration'. Until it is corrected," >&2
      echo "promote the previous deployment (Vercel → Deployments → Promote), then fix it and deploy again." >&2
      ;;
  esac
  die "$SITE did not report migration $want within five minutes."
}

# --- the worker, on Fly.io -------------------------------------------------
#
# One app, ONE machine that never stops (fly.toml's header says why), its
# secrets imported from this run's environment over stdin and never echoed,
# then the web app pointed at it.
#
# Two jobs of the Production workflow, on two VMs (review round 8, [5]):
# `worker` holds the worker's secrets, deploys to Fly and sets the web app's
# variables through our own REST helper; `worker-web` holds VERCEL_* alone
# and runs the Vercel CLI to redeploy the web app. A step boundary would not
# do: a process reads the environment of the shells above it from /proc.
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
#
# The marker is written by the second job, after the web redeploy is
# verified, from what the first left for it on Vercel ($PENDING) — not from
# a job output. GitHub drops a job output whose value contains any secret
# value of the job that set it, as a substring and at any length, and the
# worker job's secrets include FLY_ORG (which a Fly app name can contain),
# ports, and SMTP_SECURE/IMAP_SECURE, which are `true` or `false`. For the
# same reason the one output, `redeploy`, is read fail-open: the second job
# is skipped only on a `false` that arrived (production.yml).

# flyctl, handed Fly's token for that one call and nothing else of WORKER_ONLY.
fly() { FLY_API_TOKEN=$FLY_API_TOKEN flyctl "$@"; }

APP=
fly_app() {
  [ -n "${FLY_API_TOKEN:-}" ] || die "The FLY_API_TOKEN secret is not set (an ORG token: fly.io → Tokens)."
  local want existing first_error
  want=$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)
  existing=$(fly apps list --json | node -e '
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
  if first_error=$(fly apps create "$want" --org "${FLY_ORG:-personal}" 2>&1); then
    APP=$want
  else
    # Fly app names are global: somebody else may hold this one.
    APP="$want-$(openssl rand -hex 3)"
    fly apps create "$APP" --org "${FLY_ORG:-personal}" >/dev/null 2>&1 || {
      echo "first attempt: $first_error"
      die "Could not create a Fly app. FLY_API_TOKEN must be an ORG token, and the org needs a payment method."
    }
  fi
  echo "fly: created app $APP"
}

# "<name> <digest>" per secret on the app. The digest is Fly's own hash of
# the value — never the value, which Fly does not return to anybody.
fly_secrets() {
  fly secrets list --app "$APP" --json | node -e '
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
# What a wiring run leaves for `worker-web` to record once the web app is
# redeployed: "<run id>/<the marker's value>", or "<run id>/" when Fly gave
# no digest to record. An encrypted Vercel production variable, holding no
# secret, that nothing in the app reads. The run id is the workflow run's,
# which both jobs share, so `worker-web` never records another run's wiring.
PENDING=AGENT_INTERNAL_TOKEN_PENDING

# The workflow run both jobs belong to; a re-run of a failed job keeps it.
run_id() {
  [ -n "${GITHUB_RUN_ID:-}" ] || die "GITHUB_RUN_ID is not set: the worker actions run from the Production workflow only."
  export RUN_ID=$GITHUB_RUN_ID
}

# A job output, for production.yml's `outputs:`. Never a secret: GitHub
# would drop it, and it would be in the run's record.
output() {
  [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

# Job 1 of 2 (production.yml, job `worker`): Fly, and the web app's
# variables — never the Vercel CLI, so never `vercel pull` for the database
# URL either.
worker() {
  [ -n "${FLY_API_TOKEN:-}" ] || die "The FLY_API_TOKEN secret is not set (an ORG token: fly.io → Tokens)."
  [ -n "${PRODUCTION_DATABASE_URL:-}" ] \
    || die "The worker action needs the PRODUCTION_DATABASE_URL secret (Neon's DIRECT string). Its job holds the worker's secrets, so it never runs the Vercel CLI, the only other way this script finds the database URL. Nothing was created or deployed."
  run_id
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
  # AGENT_URL must still point at THIS app: run-worker.sh's chat option has
  # the operator set AGENT_URL and the token by hand for a tunnel to their own
  # machine, and the marker alone would then keep that wiring while Fly held
  # another token (review round 15). A value set Sensitive never reads back,
  # so it never matches, and the run wires afresh — the safe direction.
  if [ -n "$digest" ] && vercel_env has AGENT_INTERNAL_TOKEN && vercel_env has AGENT_URL \
    && VALUE="https://$APP.fly.dev" vercel_env equals AGENT_URL \
    && VALUE="$APP:$digest" vercel_env equals "$MARKER"; then
    wire=false
    echo "wiring: Vercel was wired to this app's current token by a run that finished; keeping it"
  else
    token=$(openssl rand -hex 32)
    echo "::add-mask::$token"
    add AGENT_INTERNAL_TOKEN "$token"
    echo "wiring: no record that both sides hold the same token; a new one goes to Fly AND Vercel in this run"
  fi
  # Everything optional, only when this run was handed it; Fly's own two are
  # flyctl's, not the worker's.
  local n
  for n in "${WORKER_ONLY[@]}"; do
    case $n in FLY_API_TOKEN | FLY_ORG) continue ;; esac
    if [ -n "${!n:-}" ]; then add "$n" "${!n}"; fi
  done
  printf '%s' "$lines" | fly secrets import --app "$APP" --stage >/dev/null
  echo "fly: secrets staged: $(printf '%s' "$lines" | cut -d= -f1 | tr '\n' ' ')"
  # Fly holds them now, and nothing later in this run needs one: only
  # FLY_API_TOKEN stays, for the flyctl calls below.
  lines=
  for n in "${WORKER_ONLY[@]}"; do
    [ "$n" = FLY_API_TOKEN ] || unset "$n"
  done

  fly deploy --app "$APP" --config fly.toml --remote-only --ha=false
  fly scale count 1 --app "$APP" --yes >/dev/null
  worker_ready

  if $wire; then
    VALUE="https://$APP.fly.dev" node tools/vercel-env.mjs set AGENT_URL encrypted
    VALUE="$token" node tools/vercel-env.mjs set AGENT_INTERNAL_TOKEN sensitive
    # After the token, never before it: what is left to record must never
    # name a token Vercel does not hold yet.
    digest=$(fly_token_digest) || digest=
    [ -n "$digest" ] \
      || echo "::warning::Fly reported no digest for AGENT_INTERNAL_TOKEN, so the wiring cannot be recorded; the web app is still redeployed, and the next run will rotate the token and wire both sides again."
    VALUE="$RUN_ID/${digest:+$APP:$digest}" node tools/vercel-env.mjs set "$PENDING" encrypted
    # A new deployment is what picks the variables up, and it is the next
    # job's, which records the wiring last.
    echo "wiring: set on Vercel; the worker-web job redeploys the web app, then records it"
  else
    worker_seen
  fi
  output redeploy "$wire"
}

# Job 2 of 2 (production.yml, job `worker-web`, after `worker`): VERCEL_*
# alone, on a VM that never held a worker secret, so the Vercel CLI it runs
# can read none — not even from /proc/<pid>/environ of a process above it.
#
# REDEPLOY is the worker job's one output, as it arrived ('' when GitHub
# dropped it). An arrived `true` says job 1 set a new token on Fly AND on
# Vercel in this run, so finding no record of this run is never "the
# existing wiring was kept" (review round 9, [8]): the live web app holds
# the old token, and every call it makes to the worker is refused. That
# stops the run, red, and the next one rotates and wires both sides again —
# unless a LATER run has written its own record since, which is what a
# re-run of an old run's second job finds. That record is the later run's
# FIRST job's, so it says only that the later run set a newer token: this
# job has nothing left to do only once the later run's own web job has
# promoted it to the marker (review round 10, [3]). Until then it stops,
# naming that run, because the live web app may hold neither token — an
# empty record, which no web job can promote, passes with a warning. A
# dropped output still reads the record alone, fail-open, as above.
worker_web() {
  run_id
  vercel_ids
  if vercel_env pending "$PENDING"; then
    deploy
    verify
    # Last: only a run that got this far may say both sides agree.
    local rc=0
    node tools/vercel-env.mjs promote "$PENDING" "$MARKER" || rc=$?
    case $rc in
      0) echo "wiring: recorded — Fly and the live web app hold this run's token" ;;
      1) echo "::warning::This run's wiring could not be recorded (Fly reported no digest for AGENT_INTERNAL_TOKEN; the worker job's log says so). The next run will rotate the token and wire both sides again." ;;
      *) die "Could not record the wiring on Vercel (the line above says why); the web app is deployed, and the next run will rotate the token and wire both sides again." ;;
    esac
  elif [ "${REDEPLOY:-}" != true ]; then
    echo "wiring: nothing of this run is waiting to be recorded (the worker job kept the existing wiring); the web app is not redeployed"
  else
    # Not vercel_env: its `die` would print into $later. The helper prints
    # the later run's id, and nothing else, on stdout.
    local later="" rc=0
    later=$(node tools/vercel-env.mjs superseded "$PENDING" "$MARKER") || rc=$?
    case $rc in
      0) echo "wiring: nothing of this run is waiting to be recorded — a later run has wired since (run $later); the web app is not redeployed" ;;
      1)
        [ -z "$later" ] \
          || die "Workflow run $later set a newer token and its web job has not finished — re-run that run's worker-web job, or the worker action. This job deployed and recorded nothing, and until one of them finishes the live web app may still run on a token the worker no longer accepts."
        die "The worker job set a new AGENT_INTERNAL_TOKEN on Fly and Vercel in this run, but no record of this run can be read from $PENDING, so the web app was not redeployed: its live deployment still runs on the old token, and every call it makes to the worker is refused. Run the worker action again — it finds no record of a finished wiring, and wires both sides again."
        ;;
      *) die "Could not read the Vercel project's variables (the line above says why); nothing was changed." ;;
    esac
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
  worker-web) worker_web ;;
  *) die "unknown action: $ACTION" ;;
esac
