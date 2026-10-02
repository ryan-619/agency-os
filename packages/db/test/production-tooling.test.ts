/**
 * The Production workflow's `worker` action (tools/production.sh,
 * tools/vercel-env.mjs, .github/workflows/production.yml), driven against
 * stubs: a `flyctl`, `npx` (the Vercel CLI), the lockfile's `tsc`, `curl`
 * and `sleep`, a `node` in front of the real one, and stand-ins for the
 * repo's own helper scripts in a scratch copy of the layout the script
 * reads — so the REAL script runs, and nothing it calls reaches Fly,
 * Vercel, a database or the network. Each JOB of the workflow is a run of
 * the script with exactly the environment that job's step hands it, read
 * from production.yml itself.
 *
 * Review round 6:
 *
 *  [10] `! vercel-env.mjs has …` read an API error (exit 2) as "absent" and
 *       rotated the token; and a run cut off part-way — Fly re-tokened with
 *       Vercel never set, or Vercel set with the web app never redeployed —
 *       read as wired to the next run, which checked only that the names
 *       existed and went green with every web call to the worker refused.
 *  [11]/[17] `worker` deployed the checkout's worker, and on first wiring
 *       its web app, without asking whether production had the checkout's
 *       migration — code ahead of its schema, against "migrate FIRST".
 *  [9]  setup-flyctl ran on `@master` in the job holding every production
 *       credential, and every worker secret reached every action's step.
 *
 * Review round 7:
 *
 *  [6]  Inside the worker step, every worker secret — SECRETS_KEY, Fly's org
 *       token, the model key, both mailbox passwords, DoveSoft's key — stayed
 *       in the environment of everything the script ran after Fly had them,
 *       the Vercel CLI included: `npx` installs it at run time with no
 *       lockfile, and `vercel build` runs the whole web build. Every stub
 *       here records the NAMES in its environment, and only flyctl may see
 *       one, FLY_API_TOKEN alone.
 *
 * Review round 8:
 *
 *  [5]  Round 7's `export -n`/`env -u`/`unset` changed what the Vercel CLI
 *       INHERITED, not what it could READ: every worker secret stayed in
 *       /proc/<pid>/environ of the step's shell and the script's, which any
 *       process of the same user reads. The `npx` stub here walks its
 *       ancestors' /proc environ the way such a payload would. Now the
 *       worker's secrets and the Vercel CLI are in different JOBS: `worker`
 *       never runs the CLI, and `worker-web` is never handed a worker
 *       secret. And because GitHub DROPS a job output that contains any
 *       secret value of its job, the harness drops outputs the way the
 *       runner does, so the hand-over between the jobs is tested against it.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = resolve(root, 'tools/production.sh')
const vercelEnv = resolve(root, 'tools/vercel-env.mjs')
const yml = readFileSync(resolve(root, '.github/workflows/production.yml'), 'utf8')
const EXPECTED = /EXPECTED_MIGRATION = '(\d+)'/.exec(readFileSync(resolve(root, 'packages/db/src/schema-version.ts'), 'utf8'))![1]!
const PASSWORD = 'db-password-never-printed-5521'
const APP = 'agency-os-agent'

/**
 * The worker job's own secrets (.github/workflows/production.yml), which
 * production.sh's WORKER_ONLY must list exactly: the workflow hands them to
 * the `worker` job's script step alone, and the script hands them to flyctl
 * alone.
 */
const WORKER_ONLY = [
  'FLY_API_TOKEN', 'FLY_ORG', 'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'AGENT_MODEL', 'SECRETS_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'MAIL_FROM',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASSWORD', 'IMAP_SECURE', 'IMAP_MAILBOX',
  'SLACK_WEBHOOK_URL', 'UNSUBSCRIBE_SECRET', 'DOVESOFT_API_KEY', 'DOVESOFT_ENTITY_ID',
]
const VERCEL_SECRETS = ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM']
/** What Fly is handed over stdin: everything but Fly's own two, which are flyctl's. */
const STAGED = WORKER_ONLY.filter((n) => n !== 'FLY_API_TOKEN' && n !== 'FLY_ORG')
/** A value no output may carry, for each — and one the /proc reader below looks for. */
const secretOf = (name: string) => `${name.toLowerCase()}-value-never-printed-8813`

/** Fly's digest, as the stub computes it: a hash of the value, never the value. */
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)

// ---------------------------------------------------------------------------
// The workflow, as text: its jobs, their steps, and what each step is handed
// ---------------------------------------------------------------------------

/** Each job's block, by id. */
const jobs: ReadonlyMap<string, string> = (() => {
  const body = yml.slice(yml.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)]
  return new Map(starts.map((m, i) => [m[1]!, body.slice(m.index, starts[i + 1]?.index ?? body.length)]))
})()
const jobOf = (id: string) => {
  const job = jobs.get(id)
  if (!job) throw new Error(`production.yml has no job ${id}`)
  return job
}
const stepsOf = (job: string) => job.slice(job.indexOf('    steps:\n')).split(/\n {6}- /).slice(1)
/** The names a step's `env:` sets. */
const envOf = (step: string) => [...step.matchAll(/^ {10}([A-Z_]+): /gm)].map((m) => m[1]!)
/** The step of `job` that runs tools/production.sh. */
const scriptStepOf = (job: string) => {
  const found = stepsOf(job).filter((s) => /\n {8}run: tools\/production\.sh /.test(s))
  expect(found, 'one step runs tools/production.sh').toHaveLength(1)
  return found[0]!
}
/** Every secret a job's text references, by name — what the runner registers with its secret masker. */
const secretsReferencedBy = (job: string) => [...new Set([...job.matchAll(/\bsecrets\.([A-Z_]+)/g)].map((m) => m[1]!))]

// ---------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------

/**
 * Every bash stub, and the `node` in front of the real one, appends
 * `<who>\t<the names in its environment>` to env.log: names, never values.
 */
const RECORD = `record() { printf '%s\\t%s\\n' "$1" "$(compgen -e | tr '\\n' ' ')" >>"$STUB_STATE/env.log"; }`

/** `node`: records which script it runs (or `-e`), then runs the real one. */
const NODE = `#!/usr/bin/env bash
${RECORD}
record "node \${1##*/}"
exec "$REAL_NODE" "$@"
`

/** `flyctl`'s launcher: records itself, then runs flyctl.js on the real node (so it is not recorded twice). */
const FLYCTL_LAUNCHER = `#!/usr/bin/env bash
${RECORD}
record "flyctl $*"
exec "$REAL_NODE" "$(dirname "$0")/../flyctl.js" "$@"
`

/** `flyctl`: apps, secrets (name → value, listed as name + digest), deploy, scale. */
const FLYCTL = `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const state = process.env.STUB_STATE
const args = process.argv.slice(2)
fs.appendFileSync(path.join(state, 'calls.log'), 'flyctl ' + args.join(' ') + '\\n')
const file = path.join(state, 'fly-secrets.json')
const secrets = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const noDigest = fs.existsSync(path.join(state, 'fly-no-digest'))
const digest = (v) => (noDigest ? '' : crypto.createHash('sha256').update(v).digest('hex').slice(0, 16))
const [a, b] = args
if (a === 'apps' && b === 'list') { console.log(JSON.stringify([{ Name: 'other' }, { Name: '${APP}' }])); process.exit(0) }
if (a === 'secrets' && b === 'list') {
  console.log(JSON.stringify(Object.entries(secrets).map(([Name, v]) => ({ Name, Digest: digest(v) }))))
  process.exit(0)
}
if (a === 'secrets' && b === 'import') {
  const input = fs.readFileSync(0, 'utf8')
  for (const line of input.split('\\n')) {
    const i = line.indexOf('=')
    if (i > 0) secrets[line.slice(0, i)] = line.slice(i + 1)
  }
  fs.writeFileSync(file, JSON.stringify(secrets))
  process.exit(0)
}
if (a === 'deploy' && fs.existsSync(path.join(state, 'fly-deploy-fails'))) process.exit(1)
process.exit(0)
`

/**
 * What a payload in the Vercel CLI's tree could READ of the secrets above it
 * (review round 8, [5]): each ancestor's /proc/<pid>/environ — the
 * environment it was started with, which no `export -n`, `env -u` or
 * `unset` changes. Appends `<who>\t<names>` to environ.log for every name
 * whose value is one of this file's never-printed values. Linux only; a
 * system with no /proc records nothing.
 */
const ENVIRON_READER = `const fs = require('node:fs'), path = require('node:path')
if (!fs.existsSync('/proc/self/stat')) process.exit(0)
const found = new Set()
let pid = process.ppid
while (pid > 1) {
  let env = ''
  try { env = fs.readFileSync('/proc/' + pid + '/environ', 'utf8') } catch {}
  for (const kv of env.split('\\0')) {
    const m = /^([A-Z_]+)=.*never-printed/.exec(kv)
    if (m) found.add(m[1])
  }
  let stat
  try { stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8') } catch { break }
  pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
}
fs.appendFileSync(path.join(process.env.STUB_STATE, 'environ.log'), process.argv[2] + '\\t' + [...found].sort().join(' ') + '\\n')
`

/**
 * `npx`: the Vercel CLI's pull, build and deploy are recorded, and each reads
 * its ancestors' /proc environ first. A pull writes the project's
 * DATABASE_URL, as `vercel pull` does where it is not Sensitive.
 */
const NPX = `#!/usr/bin/env bash
${RECORD}
record "npx $*"
echo "npx $*" >>"$STUB_STATE/calls.log"
"$REAL_NODE" "$(dirname "$0")/../environ.js" "npx $*"
case " $* " in
  *" pull "*) mkdir -p .vercel && echo "DATABASE_URL=postgres://owner:${PASSWORD}@db.example/neondb" >.vercel/.env.production.local ;;
  *" build "*) mkdir -p .vercel/output/functions ;;
  *" deploy "*) [ -e "$STUB_STATE/web-deploy-fails" ] && exit 1 ;;
esac
exit 0
`

/** The lockfile's `tsc` (node_modules/.bin/tsc): `--build` does nothing here. */
const TSC = `#!/usr/bin/env bash
${RECORD}
record "tsc $*"
echo "tsc $*" >>"$STUB_STATE/calls.log"
exit 0
`

/** `curl`: the worker answers /readyz, and the site reports the checkout's schema (or one behind) and a live worker. */
const CURL = `#!/usr/bin/env bash
${RECORD}
record curl
url="\${@: -1}"
echo "curl $url" >>"$STUB_STATE/calls.log"
applied="$EXPECTED"
[ -e "$STUB_STATE/health-behind" ] && applied=behind
case "$*" in
  *"%{http_code}"*) printf 200 ;;
  *"/api/health?strict=1"*) printf '{"database":"ok","schema":{"expected":"%s","applied":"%s"}}' "$EXPECTED" "$applied" ;;
  *"/api/health"*) printf '{"database":"ok","worker":{"status":"live"}}' ;;
  *) exit 7 ;;
esac
`

/**
 * tools/vercel-env.mjs's stand-in: production variables in a JSON file; an
 * API error on request. `pending` and `promote` read "<run id>/<value>", as
 * the real one does (its own tests are below).
 */
const VERCEL_ENV_STUB = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const state = process.env.STUB_STATE
const args = process.argv.slice(2)
const [cmd, key, to] = args
fs.appendFileSync(path.join(state, 'calls.log'), 'vercel-env ' + args.join(' ') + '\\n')
if (fs.existsSync(path.join(state, 'vercel-api-down'))) { console.error('::error::listing the project’s variables failed: HTTP 500'); process.exit(2) }
const file = path.join(state, 'vercel-vars.json')
const vars = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const save = () => fs.writeFileSync(file, JSON.stringify(vars))
const ofThisRun = () => {
  const v = vars[key], prefix = process.env.RUN_ID + '/'
  return typeof v === 'string' && v.startsWith(prefix) ? v.slice(prefix.length) : null
}
if (cmd === 'has') process.exit(key in vars ? 0 : 1)
if (cmd === 'equals') process.exit(vars[key] === process.env.VALUE ? 0 : 1)
if (cmd === 'set') { vars[key] = process.env.VALUE; save(); console.log('vercel: ' + key + ' set'); process.exit(0) }
if (cmd === 'pending') process.exit(ofThisRun() === null ? 1 : 0)
if (cmd === 'promote') {
  const record = ofThisRun()
  if (!record) process.exit(1)
  vars[to] = record; save(); console.log('vercel: ' + to + ' set'); process.exit(0)
}
process.exit(2)
`

/** tools/production-env.mjs's stand-in: the database URL comes from the secret, else from the pulled file. */
const PRODUCTION_ENV_STUB = `#!/usr/bin/env node
import fs from 'node:fs'
const [cmd, file, out] = process.argv.slice(2)
const pulled = () => /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(file, 'utf8'))[1]
if (cmd === 'database-url') fs.writeFileSync(out, process.env.PRODUCTION_DATABASE_URL || pulled())
`

/** tools/vercel-project.mjs's stand-in: the ids the API would answer with. */
const VERCEL_PROJECT_STUB = `#!/usr/bin/env node
console.log('VERCEL_ORG_ID=team_stub')
console.log('VERCEL_PROJECT_ID=prj_stub')
`

/** packages/db/dist/cli.js's stand-in: \`status\` lists the migrations up to the one applied. */
const CLI_STUB = `const fs = require('node:fs'), path = require('node:path')
const applied = fs.readFileSync(path.join(process.env.STUB_STATE, 'applied'), 'utf8').trim()
const want = '${EXPECTED}'
if (process.argv[2] !== 'status') process.exit(1)
console.log('database: db.example:5432/neondb')
for (let v = 1; v <= Number(want); v++) {
  const id = String(v).padStart(4, '0')
  console.log('  ' + (id <= applied ? '[x]' : '[ ]') + ' ' + id + '_migration')
}
console.log(applied >= want ? 'up to date' : 'pending')
`

interface Seen {
  readonly who: string
  readonly names: readonly string[]
}

/** One job: the script run with that job's step environment. */
interface JobRun {
  readonly status: number | null
  readonly out: string
  readonly calls: string[]
  /** What each process it started had in its environment, by name. */
  readonly seen: Seen[]
  /** What each Vercel CLI call could read from its ancestors' /proc environ, by name. */
  readonly read: Seen[]
}

/** The worker action: job `worker`, then — when its `if:` holds — job `worker-web`. */
interface WorkflowRun {
  readonly runId: string
  readonly worker: JobRun
  /** The job outputs `worker-web` sees, after the runner has dropped any that hold a secret. */
  readonly outputs: Record<string, string>
  readonly dropped: string[]
  readonly web: JobRun | null
}

/**
 * The Actions secrets of a test; a name not here is an unset secret, which
 * GitHub hands a step as ''.
 */
type Secrets = Record<string, string | undefined>
const BASE_SECRETS: Secrets = {
  PRODUCTION_DATABASE_URL: `postgres://owner:${PASSWORD}@db.example/neondb`,
  VERCEL_TOKEN: 'vercel-token-stub',
  VERCEL_ORG_ID: 'team_stub',
  VERCEL_PROJECT_ID: 'prj_stub',
  FLY_API_TOKEN: 'fly-token-stub',
}
const everySecret = Object.fromEntries(WORKER_ONLY.map((n) => [n, secretOf(n)]))
const parseSeen = (text: string): Seen[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [who = '', names = ''] = line.split('\t')
      return { who, names: names.split(' ').filter(Boolean) }
    })
const leaked = (s: Seen) => s.names.filter((n) => WORKER_ONLY.includes(n))
const whos = (all: readonly Seen[]) => all.map((s) => s.who)

describe('the worker action', () => {
  let dir: string
  let state: string
  let nextRun = 9000

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'production-tooling-'))
    state = join(dir, 'state')
    for (const d of ['bin', 'tools', 'node_modules/.bin', 'packages/db/src', 'packages/db/dist', 'state', 'runner']) {
      mkdirSync(join(dir, d), { recursive: true })
    }
    const exe = (path: string, body: string) => {
      writeFileSync(join(dir, path), body)
      chmodSync(join(dir, path), 0o755)
    }
    exe('bin/node', NODE)
    exe('bin/flyctl', FLYCTL_LAUNCHER)
    writeFileSync(join(dir, 'flyctl.js'), FLYCTL)
    writeFileSync(join(dir, 'environ.js'), ENVIRON_READER)
    exe('bin/npx', NPX)
    exe('bin/curl', CURL)
    exe('bin/sleep', '#!/usr/bin/env bash\nexit 0\n')
    exe('node_modules/.bin/tsc', TSC)
    exe('tools/vercel-env.mjs', VERCEL_ENV_STUB)
    exe('tools/production-env.mjs', PRODUCTION_ENV_STUB)
    exe('tools/vercel-project.mjs', VERCEL_PROJECT_STUB)
    writeFileSync(join(dir, 'packages/db/dist/cli.js'), CLI_STUB)
    copyFileSync(resolve(root, 'packages/db/src/schema-version.ts'), join(dir, 'packages/db/src/schema-version.ts'))
    writeFileSync(join(dir, 'fly.toml'), `app = "${APP}"\n`)
    // The flyctl stub and cli.js are CommonJS; say so for the scratch tree.
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n')
    applied(EXPECTED)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const applied = (version: string) => writeFileSync(join(state, 'applied'), version)
  const flySecrets = (): Record<string, string> => {
    const file = join(state, 'fly-secrets.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }
  const setFly = (secrets: Record<string, string>) => writeFileSync(join(state, 'fly-secrets.json'), JSON.stringify(secrets))
  const vercelVars = (): Record<string, string> => {
    const file = join(state, 'vercel-vars.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }
  const setVercel = (vars: Record<string, string>) => writeFileSync(join(state, 'vercel-vars.json'), JSON.stringify(vars))
  const flag = (name: string, on = true) => (on ? writeFileSync(join(state, name), '') : rmSync(join(state, name), { force: true }))

  /**
   * Run one job of the workflow: `tools/production.sh <arg>` with what the
   * job's script step hands it — each `${{ secrets.X }}` in its env, '' when
   * unset — plus the runner's own variables.
   */
  function runJob(jobId: string, arg: string, secrets: Secrets, runId: string): JobRun {
    for (const f of ['calls.log', 'env.log', 'environ.log']) writeFileSync(join(state, f), '')
    const output = join(dir, 'runner', `${jobId}.output`)
    writeFileSync(output, '')
    const env: Record<string, string> = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? dir,
      STUB_STATE: state,
      REAL_NODE: process.execPath,
      EXPECTED,
      RUNNER_TEMP: join(dir, 'runner'),
      GITHUB_RUN_ID: runId,
      GITHUB_OUTPUT: output,
      PRODUCTION_URL: 'https://site.example',
    }
    const step = scriptStepOf(jobOf(jobId))
    expect(step).toContain(`run: tools/production.sh ${arg}\n`)
    for (const m of step.matchAll(/^ {10}([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}$/gm)) env[m[1]!] = secrets[m[2]!] ?? ''
    const r = spawnSync('bash', [script, arg], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 })
    const read = (f: string) => readFileSync(join(state, f), 'utf8')
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      calls: read('calls.log').split('\n').filter(Boolean),
      seen: parseSeen(read('env.log')),
      read: parseSeen(read('environ.log')),
    }
  }

  /**
   * The whole action. The runner registers every secret the job references
   * and every `::add-mask::` value, and SKIPS a job output whose value any of
   * them occurs in ("Skip output '…' since it may contain secret" —
   * actions/runner JobExtension.cs): no minimum length, as a substring.
   * `worker-web`'s `if:` is then evaluated from production.yml itself.
   */
  function runWorkflow(secrets: Secrets = {}, runId = String(nextRun++)): WorkflowRun {
    const all = { ...BASE_SECRETS, ...secrets }
    const worker = runJob('worker', 'worker', all, runId)
    const job = jobOf('worker')
    const masks = [
      ...secretsReferencedBy(job).map((n) => (all[n] ?? '').trim()),
      ...[...worker.out.matchAll(/^::add-mask::(.*)$/gm)].map((m) => m[1]!.trim()),
    ].filter(Boolean)
    const written: Record<string, string> = Object.fromEntries(
      readFileSync(join(dir, 'runner', 'worker.output'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
    const outputs: Record<string, string> = {}
    const dropped: string[] = []
    if (worker.status === 0) {
      for (const m of job.matchAll(/^ {6}([a-z_]+): \$\{\{ steps\.([a-z_]+)\.outputs\.([a-z_]+) \}\}$/gm)) {
        const value = written[m[3]!]
        if (value === undefined || value === '') continue
        if (masks.some((s) => value.includes(s))) dropped.push(m[1]!)
        else outputs[m[1]!] = value
      }
    }
    const web = worker.status === 0 && webJobRuns(outputs) ? runJob('worker-web', 'worker-web', all, runId) : null
    return { runId, worker, outputs, dropped, web }
  }

  /** `worker-web`'s `if:`, read from production.yml: `needs.worker.outputs.<name> <op> '<value>'` and nothing else. */
  function webJobRuns(outputs: Record<string, string>): boolean {
    const m = /^ {4}if: needs\.worker\.outputs\.([a-z_]+) (==|!=) '([^']*)'$/m.exec(jobOf('worker-web'))
    if (!m) throw new Error('worker-web’s `if:` is not a comparison of one of worker’s outputs; teach this harness the new one')
    const value = outputs[m[1]!] ?? ''
    return m[2] === '==' ? value === m[3] : value !== m[3]
  }

  const staged = (j: JobRun) => j.calls.filter((c) => c.startsWith('flyctl secrets import'))
  const flyDeploys = (j: JobRun) => j.calls.filter((c) => c.startsWith('flyctl deploy'))
  const webDeploys = (j: JobRun | null) => (j?.calls ?? []).filter((c) => /^npx .*vercel@\S+ deploy /.test(c))
  const vercelSets = (j: JobRun | null) => (j?.calls ?? []).filter((c) => c.startsWith('vercel-env set'))
  const promotes = (j: JobRun | null) => (j?.calls ?? []).filter((c) => c.startsWith('vercel-env promote'))
  const MARKER = 'AGENT_INTERNAL_TOKEN_WIRED'
  const PENDING = 'AGENT_INTERNAL_TOKEN_PENDING'

  /** Both sides agree, as a finished run leaves them — the record it promoted still beside the marker. */
  const wired = (token = 'a'.repeat(64)) => {
    setFly({ DATABASE_URL: 'x', AGENT_INTERNAL_TOKEN: token })
    setVercel({
      AGENT_URL: `https://${APP}.fly.dev`,
      AGENT_INTERNAL_TOKEN: token,
      [MARKER]: `${APP}:${digestOf(token)}`,
      [PENDING]: `1234/${APP}:${digestOf(token)}`,
    })
  }

  /** The two sides hold one token, and the live web app was deployed with it. */
  const expectWiredTogether = () => {
    const fly = flySecrets()
    const vercel = vercelVars()
    expect(fly.AGENT_INTERNAL_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(vercel.AGENT_INTERNAL_TOKEN).toBe(fly.AGENT_INTERNAL_TOKEN)
    expect(vercel.AGENT_URL).toBe(`https://${APP}.fly.dev`)
    expect(vercel[MARKER]).toBe(`${APP}:${digestOf(fly.AGENT_INTERNAL_TOKEN!)}`)
  }

  /** Both jobs ran and finished. */
  const expectBothJobs = (r: WorkflowRun) => {
    expect(r.worker.status, r.worker.out).toBe(0)
    expect(r.web, 'worker-web ran').not.toBeNull()
    expect(r.web!.status, r.web!.out).toBe(0)
  }

  it('wires a fresh app: one token on both sides, the web app redeployed by worker-web, and the record written LAST', () => {
    const r = runWorkflow()
    expectBothJobs(r)
    expect(r.outputs).toEqual({ redeploy: 'true' })
    expectWiredTogether()
    expect(webDeploys(r.worker)).toEqual([])
    expect(webDeploys(r.web)).toHaveLength(1)
    // The variables are set by the worker job, before the redeploy that
    // picks them up; the marker by the web job, after it verifies.
    expect(vercelSets(r.worker).map((c) => c.split(' ')[2])).toEqual(['AGENT_URL', 'AGENT_INTERNAL_TOKEN', PENDING])
    expect(vercelSets(r.web)).toEqual([])
    const calls = r.web!.calls
    const deployAt = calls.indexOf(webDeploys(r.web)[0]!)
    const verifiedAt = calls.lastIndexOf('curl https://site.example/api/health?strict=1')
    const markerAt = calls.indexOf(`vercel-env promote ${PENDING} ${MARKER}`)
    expect(deployAt).toBeGreaterThan(-1)
    expect(verifiedAt).toBeGreaterThan(deployAt)
    expect(markerAt).toBeGreaterThan(verifiedAt)
    expect(r.web!.out).toContain('live: https://site.example/api/health reports the worker live')
    expect(calls.indexOf('curl https://site.example/api/health')).toBeGreaterThan(markerAt)
    expect(`${r.worker.out}${r.web!.out}`).not.toContain(PASSWORD)
  })

  it('keeps a wiring a finished run recorded: no new token, nothing set on Vercel, and no web job', () => {
    wired()
    const r = runWorkflow()
    expect(r.worker.status, r.worker.out).toBe(0)
    expect(r.outputs).toEqual({ redeploy: 'false' })
    expect(r.web).toBeNull()
    expect(staged(r.worker)).toHaveLength(1)
    expect(flySecrets().AGENT_INTERNAL_TOKEN).toBe('a'.repeat(64))
    expect(vercelSets(r.worker)).toEqual([])
    expect(flyDeploys(r.worker)).toHaveLength(1)
    expect(r.worker.out).toContain('live: https://site.example/api/health reports the worker live')
  })

  describe('a Vercel API error is not "absent" ([10])', () => {
    it('stops the run before a token is generated or anything is staged', () => {
      wired()
      flag('vercel-api-down')
      const r = runWorkflow()
      expect(r.worker.status).not.toBe(0)
      expect(r.worker.out).toMatch(/Could not read the Vercel project's variables/)
      expect(staged(r.worker)).toEqual([])
      expect(flyDeploys(r.worker)).toEqual([])
      expect(r.web).toBeNull()
      // Fly kept the token both sides share.
      expect(flySecrets().AGENT_INTERNAL_TOKEN).toBe('a'.repeat(64))
    })
  })

  describe('a run cut off part-way is repaired by the next ([10])', () => {
    it('Fly re-tokened and Vercel never set: the names all exist, and the next run still wires both sides again', () => {
      // What the old run left: Fly on a new token, Vercel on the old one,
      // and no record of a finished wiring for Fly's token.
      setFly({ DATABASE_URL: 'x', AGENT_INTERNAL_TOKEN: 'b'.repeat(64) })
      setVercel({
        AGENT_URL: `https://${APP}.fly.dev`,
        AGENT_INTERNAL_TOKEN: 'a'.repeat(64),
        [MARKER]: `${APP}:${digestOf('a'.repeat(64))}`,
      })
      const r = runWorkflow()
      expectBothJobs(r)
      expect(staged(r.worker)).toHaveLength(1)
      expect(flySecrets().AGENT_INTERNAL_TOKEN).not.toBe('b'.repeat(64))
      expectWiredTogether()
      expect(webDeploys(r.web)).toHaveLength(1)
    })

    it('Vercel set and the web app never redeployed: the failed web job records nothing, and the next run redeploys', () => {
      flag('web-deploy-fails')
      const first = runWorkflow()
      expect(first.worker.status, first.worker.out).toBe(0)
      expect(first.web!.status).not.toBe(0)
      expect(vercelVars().AGENT_INTERNAL_TOKEN).toBe(flySecrets().AGENT_INTERNAL_TOKEN)
      expect(vercelVars()[MARKER]).toBeUndefined()

      flag('web-deploy-fails', false)
      const second = runWorkflow()
      expectBothJobs(second)
      expect(webDeploys(second.web)).toHaveLength(1)
      expectWiredTogether()
    })

    it('a web deploy that never reports the checkout’s migration records nothing, and the next run wires again', () => {
      flag('health-behind')
      const first = runWorkflow()
      expect(first.worker.status, first.worker.out).toBe(0)
      expect(webDeploys(first.web)).toHaveLength(1)
      expect(first.web!.status).not.toBe(0)
      expect(first.web!.out).toContain(`did not report migration ${EXPECTED}`)
      expect(promotes(first.web)).toEqual([])
      expect(vercelVars()[MARKER]).toBeUndefined()

      flag('health-behind', false)
      const second = runWorkflow()
      expectBothJobs(second)
      expect(staged(second.worker)).toHaveLength(1)
      expectWiredTogether()
    })

    it('a Fly deploy that failed after a new token was staged: the next run wires both sides again', () => {
      wired()
      // A token that was never wired, staged by a run whose deploy failed.
      setFly({ DATABASE_URL: 'x', AGENT_INTERNAL_TOKEN: 'c'.repeat(64) })
      flag('fly-deploy-fails')
      const failed = runWorkflow()
      expect(failed.worker.status).not.toBe(0)
      expect(failed.web).toBeNull()
      flag('fly-deploy-fails', false)
      const r = runWorkflow()
      expectBothJobs(r)
      expectWiredTogether()
      expect(webDeploys(r.web)).toHaveLength(1)
    })

    it('a record for another app is not a record for this one', () => {
      wired()
      setVercel({ ...vercelVars(), [MARKER]: `${APP}-old:${digestOf('a'.repeat(64))}` })
      const r = runWorkflow()
      expectBothJobs(r)
      expectWiredTogether()
    })

    it('Fly reports no digest: the web app is still redeployed, nothing is recorded, and both jobs say so', () => {
      flag('fly-no-digest')
      const r = runWorkflow()
      expectBothJobs(r)
      expect(r.worker.out).toContain('Fly reported no digest for AGENT_INTERNAL_TOKEN')
      expect(webDeploys(r.web)).toHaveLength(1)
      expect(r.web!.out).toContain('could not be recorded')
      expect(vercelVars()[MARKER]).toBeUndefined()
      expect(vercelVars().AGENT_INTERNAL_TOKEN).toBe(flySecrets().AGENT_INTERNAL_TOKEN)
    })

    it('a re-run of an old run’s web job never records a newer run’s wiring', () => {
      flag('web-deploy-fails')
      const old = runWorkflow()
      expect(old.web!.status).not.toBe(0)
      flag('web-deploy-fails', false)
      const newer = runWorkflow()
      expectBothJobs(newer)
      const recorded = vercelVars()[MARKER]
      // "Re-run failed jobs" on the old run: same run id, the old outputs.
      const rerun = runJob('worker-web', 'worker-web', BASE_SECRETS, old.runId)
      expect(rerun.status, rerun.out).toBe(0)
      expect(rerun.out).toContain('nothing of this run is waiting to be recorded')
      expect(webDeploys(rerun)).toEqual([])
      expect(promotes(rerun)).toEqual([])
      expect(vercelVars()[MARKER]).toBe(recorded)
    })
  })

  describe('the Vercel CLI never runs on a VM that holds a worker secret ([5])', () => {
    it('the worker job runs no npx at all, on a wiring run as on a keeping one; the web job runs the CLI', () => {
      const wiring = runWorkflow(everySecret)
      expectBothJobs(wiring)
      wired()
      const keeping = runWorkflow(everySecret)
      expect(keeping.worker.status, keeping.worker.out).toBe(0)
      for (const r of [wiring, keeping]) {
        expect(r.worker.calls.filter((c) => c.startsWith('npx'))).toEqual([])
        expect(whos(r.worker.seen).filter((w) => w.startsWith('npx'))).toEqual([])
        // The migrator's CLI is still built — by the lockfile's tsc.
        expect(r.worker.calls).toContain('tsc --build')
      }
      // Not vacuous: the CLI's pull, build and deploy ran, in the other job.
      const cli = wiring.web!.calls.filter((c) => /^npx --yes vercel@\S+ /.test(c))
      for (const verb of ['pull', 'build', 'deploy']) expect(cli.some((c) => c.includes(` ${verb} `)), verb).toBe(true)
    })

    it('refuses without PRODUCTION_DATABASE_URL — naming it — before anything is pulled, created, staged or set', () => {
      const r = runWorkflow({ PRODUCTION_DATABASE_URL: undefined })
      expect(r.worker.status).not.toBe(0)
      expect(r.worker.out).toContain('needs the PRODUCTION_DATABASE_URL secret')
      expect(r.worker.calls).toEqual([])
      expect(r.web).toBeNull()
      expect(flySecrets()).toEqual({})
      expect(vercelVars()).toEqual({})
    })

    it('every path to the Vercel CLI in the worker action dies there, and no other action’s does', () => {
      // The script's prelude through no_vercel_cli, then a pull, as the
      // fallback for the database URL or a web deploy would make one.
      const body = readFileSync(script, 'utf8')
      const fn = body.indexOf('\nno_vercel_cli() {')
      expect(fn).toBeGreaterThan(0)
      const end = body.indexOf('\n}\n', fn) + 3
      writeFileSync(join(dir, 'prelude.sh'), `${body.slice(0, end)}"\${VERCEL[@]}" pull --yes >/dev/null\necho reached\n`)
      const run = (action: string) => {
        writeFileSync(join(state, 'calls.log'), '')
        writeFileSync(join(state, 'environ.log'), '')
        const r = spawnSync('bash', [join(dir, 'prelude.sh'), action], {
          cwd: dir,
          env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, STUB_STATE: state, REAL_NODE: process.execPath },
          encoding: 'utf8',
          timeout: 30_000,
        })
        return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(join(state, 'calls.log'), 'utf8') }
      }
      const worker = run('worker')
      expect(worker.status).not.toBe(0)
      expect(worker.out).toContain('never runs the Vercel CLI')
      expect(worker.out).not.toContain('reached')
      expect(worker.calls).toBe('')
      for (const action of ['worker-web', 'deploy', 'release', 'migrate', 'status']) {
        const other = run(action)
        expect(other.status, `${action}: ${other.out}`).toBe(0)
        expect(other.calls, action).toMatch(/^npx --yes vercel@\S+ pull /)
      }
    })

    describe.runIf(process.platform === 'linux')('/proc/<pid>/environ', () => {
      it('no Vercel CLI call can read a worker secret, or the database URL, from any process above it', () => {
        const r = runWorkflow(everySecret)
        for (const s of [...r.worker.read, ...(r.web?.read ?? [])]) expect(s.names, s.who).toEqual([])
        expectBothJobs(r)
        // Not vacuous: each call of the CLI looked.
        expect(r.web!.read.map((s) => s.who.split(' ')[3])).toEqual(['pull', 'build', 'deploy'])
      })

      it('control: un-exporting is no boundary — the reader finds what the shell above it was started with', () => {
        // Round 7's shape: the secret in the shell's initial environment,
        // `export -n` there, and `env -u` on the child's command line.
        writeFileSync(join(state, 'environ.log'), '')
        const r = spawnSync(
          'bash',
          ['-c', 'export -n SECRETS_KEY; env -u SECRETS_KEY "$REAL_NODE" environ.js "npx --yes vercel@x pull"; echo "own: ${SECRETS_KEY:+inherited}"'],
          { cwd: dir, env: { PATH: process.env.PATH ?? '', STUB_STATE: state, REAL_NODE: process.execPath, SECRETS_KEY: secretOf('SECRETS_KEY') }, encoding: 'utf8' },
        )
        expect(r.status, r.stderr).toBe(0)
        expect(parseSeen(readFileSync(join(state, 'environ.log'), 'utf8'))).toEqual([
          { who: 'npx --yes vercel@x pull', names: ['SECRETS_KEY'] },
        ])
      })
    })
  })

  describe('the worker’s secrets reach flyctl alone ([6]), and the web job is handed none', () => {
    /** In the worker job, nothing but flyctl saw a worker secret, and flyctl saw FLY_API_TOKEN and nothing else of them. */
    function expectContained(r: WorkflowRun) {
      expectBothJobs(r)
      const fly = r.worker.seen.filter((s) => s.who.startsWith('flyctl '))
      const rest = r.worker.seen.filter((s) => !s.who.startsWith('flyctl '))
      for (const s of rest) expect(leaked(s), s.who).toEqual([])
      expect(fly.length).toBeGreaterThan(0)
      for (const s of fly) expect(leaked(s), s.who).toEqual(['FLY_API_TOKEN'])
      // The web job's processes: no worker secret and no database URL, by any name.
      for (const s of r.web!.seen) {
        expect(leaked(s), s.who).toEqual([])
        expect(s.names, s.who).not.toContain('PRODUCTION_DATABASE_URL')
      }
      // Fly was still handed every one, over stdin, with its value.
      const onFly = flySecrets()
      for (const n of STAGED) expect(onFly[n], n).toBe(secretOf(n))
      expect(onFly.FLY_API_TOKEN).toBeUndefined()
      expect(onFly.FLY_ORG).toBeUndefined()
      for (const n of WORKER_ONLY) expect(`${r.worker.out}${r.web!.out}`, n).not.toContain(secretOf(n))
    }

    it('on a wiring run: every helper of ours sees none of them, and the web job’s CLI, build and helpers are never handed one', () => {
      const r = runWorkflow(everySecret)
      expectContained(r)
      for (const helper of ['node vercel-env.mjs', 'node production-env.mjs', 'node cli.js', 'node -e', 'tsc --build', 'curl']) {
        expect(whos(r.worker.seen), helper).toContain(helper)
      }
      expect(whos(r.worker.seen).some((w) => w.startsWith('flyctl secrets import'))).toBe(true)
      expect(whos(r.worker.seen).some((w) => w.startsWith('flyctl deploy'))).toBe(true)
      for (const verb of ['pull', 'build', 'deploy']) {
        expect(whos(r.web!.seen).some((w) => new RegExp(`^npx --yes vercel@\\S+ ${verb} `).test(w)), verb).toBe(true)
      }
    })

    it('when the project ids come from the API: both jobs find them with our own helper', () => {
      const r = runWorkflow({ ...everySecret, VERCEL_ORG_ID: undefined, VERCEL_PROJECT_ID: undefined })
      expectContained(r)
      expect(whos(r.worker.seen)).toContain('node vercel-project.mjs')
      expect(whos(r.web!.seen)).toContain('node vercel-project.mjs')
    })

    it('the Vercel CLI’s own command line strips every one, even one a later edit exported again', () => {
      // The script's prelude up to the VERCEL array, then every name exported
      // again by hand — the second guard must hold without the first.
      const body = readFileSync(script, 'utf8')
      const start = body.indexOf('\nVERCEL=(')
      expect(start).toBeGreaterThan(0)
      const end = body.indexOf('\n', start + 1)
      writeFileSync(
        join(dir, 'prelude.sh'),
        `${body.slice(0, end + 1)}for n in "\${WORKER_ONLY[@]}"; do export "$n"; done\n"\${VERCEL[@]}" pull --yes\n`,
      )
      writeFileSync(join(state, 'env.log'), '')
      const r = spawnSync('bash', [join(dir, 'prelude.sh'), 'status'], {
        cwd: dir,
        env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, STUB_STATE: state, REAL_NODE: process.execPath, ...everySecret },
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      const vercel = parseSeen(readFileSync(join(state, 'env.log'), 'utf8')).filter((s) => s.who.startsWith('npx --yes vercel@'))
      expect(vercel).toHaveLength(1)
      expect(leaked(vercel[0]!)).toEqual([])
    })

    it('lists exactly the worker job’s own secrets, so a new one cannot be staged without being stripped', () => {
      const body = readFileSync(script, 'utf8')
      const array = /^WORKER_ONLY=\(([^)]*)\)/m.exec(body)?.[1] ?? ''
      const names = array.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean)
      expect(new Set(names)).toEqual(new Set(WORKER_ONLY))
      expect(names).toHaveLength(WORKER_ONLY.length)
      const step = envOf(scriptStepOf(jobOf('worker')))
      expect(new Set(step.filter((n) => n !== 'PRODUCTION_DATABASE_URL' && !VERCEL_SECRETS.includes(n)))).toEqual(new Set(names))
    })
  })

  describe('a job output GitHub drops for holding a secret value cannot strand the wiring ([5])', () => {
    it('`true` dropped because SMTP_SECURE and IMAP_SECURE are `true`: the web job still runs, redeploys and records', () => {
      const r = runWorkflow({ ...everySecret, SMTP_SECURE: 'true', IMAP_SECURE: 'true' })
      // Not vacuous: the runner would drop it.
      expect(r.dropped).toEqual(['redeploy'])
      expectBothJobs(r)
      expect(webDeploys(r.web)).toHaveLength(1)
      expectWiredTogether()
    })

    it('`false` dropped because SMTP_SECURE is `false`: the web job runs, finds nothing of this run, and redeploys nothing', () => {
      wired()
      const r = runWorkflow({ ...everySecret, SMTP_SECURE: 'false' })
      expect(r.dropped).toEqual(['redeploy'])
      expectBothJobs(r)
      expect(r.web!.out).toContain('nothing of this run is waiting to be recorded')
      expect(webDeploys(r.web)).toEqual([])
      expect(promotes(r.web)).toEqual([])
      expect(vercelSets(r.web)).toEqual([])
      expect(flySecrets().AGENT_INTERNAL_TOKEN).toBe('a'.repeat(64))
      expect(vercelVars()[MARKER]).toBe(`${APP}:${digestOf('a'.repeat(64))}`)
      expect(r.web!.out).toContain('reports the worker live')
    })

    it('a FLY_ORG the app’s name contains: the wiring is still recorded, because the marker is never a job output', () => {
      const r = runWorkflow({ ...everySecret, FLY_ORG: 'agency' })
      expectBothJobs(r)
      expect(r.dropped).toEqual([])
      expectWiredTogether()
      // What the worker job wrote for the runner: the one output, a word.
      expect(readFileSync(join(dir, 'runner', 'worker.output'), 'utf8')).toBe('redeploy=true\n')
    })
  })

  describe('the schema comes first ([11], [17])', () => {
    it('refuses — before anything is created, staged or deployed — when production lacks the checkout’s migration', () => {
      applied(String(Number(EXPECTED) - 1).padStart(4, '0'))
      const r = runWorkflow()
      expect(r.worker.status).not.toBe(0)
      expect(r.worker.out).toContain(`Production has not applied migration ${EXPECTED}`)
      expect(r.worker.out).toMatch(/Run the 'release' action from this ref first/)
      expect(r.worker.calls.filter((c) => c.startsWith('flyctl'))).toEqual([])
      expect(r.worker.calls.filter((c) => c.startsWith('vercel-env'))).toEqual([])
      expect(r.web).toBeNull()
      expect(r.worker.out).not.toContain(PASSWORD)
    })

    it('never migrates: the one place that migrates is `release`', () => {
      const r = runWorkflow()
      expectBothJobs(r)
      expect([...r.worker.calls, ...r.web!.calls].filter((c) => /cli\.js up|db:migrate/.test(c))).toEqual([])
      const body = readFileSync(script, 'utf8')
      const fn = (name: string) => body.slice(body.indexOf(`\n${name}() {`), body.indexOf('\n}\n', body.indexOf(`\n${name}() {`)))
      const worker = fn('worker')
      expect(worker).not.toMatch(/\bmigrate\b|db up/)
      expect(worker.indexOf('schema_ready')).toBeGreaterThan(-1)
      expect(worker.indexOf('schema_ready')).toBeLessThan(worker.indexOf('fly_app'))
      expect(fn('worker_web')).not.toMatch(/\bmigrate\b|db up|\bdb\b/)
    })
  })
})

// ---------------------------------------------------------------------------
// tools/vercel-env.mjs's exit codes, against a fake API (a patched fetch)
// ---------------------------------------------------------------------------

describe('vercel-env.mjs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vercel-env-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Run the real script with `fetch` answering from `routes` — a path
   * prefix, or `POST <prefix>` for a write, → [status, body] — and every
   * request it made logged.
   */
  function run(args: string[], routes: Record<string, [number, unknown]>, env: Record<string, string> = {}) {
    const hook = join(dir, 'fetch.mjs')
    const log = join(dir, 'requests.log')
    writeFileSync(log, '')
    writeFileSync(
      hook,
      `import fs from 'node:fs'
const routes = ${JSON.stringify(routes)}
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  const path = new URL(url).pathname
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body: init.body ? JSON.parse(init.body) : null }) + '\\n')
  const match = (p) => (p.startsWith('POST ') ? method === 'POST' && path.startsWith(p.slice(5)) : path.startsWith(p))
  const hit = Object.keys(routes).filter(match).sort((a, b) => b.length - a.length)[0]
  const [status, body] = hit ? routes[hit] : [404, {}]
  return new Response(JSON.stringify(body), { status })
}
`,
    )
    const r = spawnSync(process.execPath, ['--import', hook, vercelEnv, ...args], {
      env: { PATH: process.env.PATH ?? '', VERCEL_TOKEN: 't', VERCEL_ORG_ID: 'team_x', VERCEL_PROJECT_ID: 'prj', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    })
    const requests = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; path: string; body: Record<string, unknown> | null })
    return { status: r.status, out: `${r.stdout}${r.stderr}`, requests }
  }

  const list = {
    envs: [
      { id: 'env_1', key: 'AGENT_INTERNAL_TOKEN_WIRED', target: ['production'], type: 'encrypted' },
      { id: 'env_2', key: 'AGENT_INTERNAL_TOKEN_PENDING', target: ['production'], type: 'encrypted' },
    ],
  }

  it('has: 0 present, 1 absent, 2 when the list cannot be read', () => {
    expect(run(['has', 'AGENT_INTERNAL_TOKEN_WIRED'], { '/v10/projects/prj/env': [200, list] }).status).toBe(0)
    expect(run(['has', 'AGENT_URL'], { '/v10/projects/prj/env': [200, list] }).status).toBe(1)
    expect(run(['has', 'AGENT_URL'], { '/v10/projects/prj/env': [500, {}] }).status).toBe(2)
  })

  it('equals: compares without printing either side, and an unreadable answer is 2, never "different"', () => {
    const routes = (status: number, value: unknown): Record<string, [number, unknown]> => ({
      '/v10/projects/prj/env': [200, list],
      '/v1/projects/prj/env/env_1': [status, { value }],
    })
    const same = run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, 'agency-os-agent:0123abcd'), { VALUE: 'agency-os-agent:0123abcd' })
    expect(same.status).toBe(0)
    expect(same.out).not.toContain('0123abcd')
    const other = run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, 'agency-os-agent:ffff'), { VALUE: 'agency-os-agent:0123abcd' })
    expect(other.status).toBe(1)
    expect(other.out).not.toContain('ffff')
    expect(run(['equals', 'AGENT_URL'], routes(200, 'x'), { VALUE: 'x' }).status).toBe(1)
    expect(run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(500, null), { VALUE: 'x' }).status).toBe(2)
    expect(run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], { '/v10/projects/prj/env': [403, {}] }, { VALUE: 'x' }).status).toBe(2)
  })

  describe('a record handed from the worker job to the web job ([5])', () => {
    const routes = (status: number, value: unknown): Record<string, [number, unknown]> => ({
      '/v10/projects/prj/env': [200, list],
      '/v1/projects/prj/env/env_2': [status, { value }],
    })
    const writes = (r: { requests: { method: string; body: Record<string, unknown> | null }[] }) =>
      r.requests.filter((q) => q.method === 'POST').map((q) => q.body)

    it('pending: 0 for a record this run wrote, 1 for another run’s or none, 2 when it cannot be read — printing no value', () => {
      const mine = run(['pending', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(200, '42/agency-os-agent:0123abcd'), { RUN_ID: '42' })
      expect(mine.status).toBe(0)
      expect(mine.out).not.toContain('0123abcd')
      expect(run(['pending', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(200, '42/agency-os-agent:0123abcd'), { RUN_ID: '43' }).status).toBe(1)
      // A prefix of the run id is another run.
      expect(run(['pending', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(200, '42/agency-os-agent:0123abcd'), { RUN_ID: '4' }).status).toBe(1)
      // An empty record — Fly gave no digest — is still this run's wiring, waiting for the redeploy.
      expect(run(['pending', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(200, '42/'), { RUN_ID: '42' }).status).toBe(0)
      expect(run(['pending', 'AGENT_URL'], routes(200, '42/x'), { RUN_ID: '42' }).status).toBe(1)
      expect(run(['pending', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(500, null), { RUN_ID: '42' }).status).toBe(2)
      expect(run(['pending', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(200, '42/x'), {}).status).toBe(2)
    })

    it('promote: sets the marker to what this run recorded, encrypted, and prints neither value', () => {
      const r = run(['promote', 'AGENT_INTERNAL_TOKEN_PENDING', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, '42/agency-os-agent:0123abcd'), { RUN_ID: '42' })
      expect(r.status, r.out).toBe(0)
      expect(writes(r)).toEqual([
        { key: 'AGENT_INTERNAL_TOKEN_WIRED', value: 'agency-os-agent:0123abcd', type: 'encrypted', target: ['production'] },
      ])
      expect(r.out).not.toContain('0123abcd')
      expect(r.out).toContain('AGENT_INTERNAL_TOKEN_WIRED set')
    })

    it('promote: 1 and nothing written for another run’s record, an empty one, or none', () => {
      for (const [value, runId] of [
        ['42/agency-os-agent:0123abcd', '43'],
        ['42/', '42'],
      ] as const) {
        const r = run(['promote', 'AGENT_INTERNAL_TOKEN_PENDING', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, value), { RUN_ID: runId })
        expect(r.status, `${value} as run ${runId}`).toBe(1)
        expect(writes(r)).toEqual([])
      }
      const none = run(['promote', 'AGENT_URL', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, '42/x'), { RUN_ID: '42' })
      expect(none.status).toBe(1)
      expect(writes(none)).toEqual([])
    })

    it('promote: 2 when the record cannot be read, the write is refused, or there is nothing to set', () => {
      expect(run(['promote', 'AGENT_INTERNAL_TOKEN_PENDING', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(500, null), { RUN_ID: '42' }).status).toBe(2)
      const refused = run(
        ['promote', 'AGENT_INTERNAL_TOKEN_PENDING', 'AGENT_INTERNAL_TOKEN_WIRED'],
        { ...routes(200, '42/agency-os-agent:0123abcd'), 'POST /v10/projects/prj/env': [500, {}] },
        { RUN_ID: '42' },
      )
      expect(refused.status).toBe(2)
      expect(refused.out).not.toContain('0123abcd')
      expect(run(['promote', 'AGENT_INTERNAL_TOKEN_PENDING'], routes(200, '42/x'), { RUN_ID: '42' }).status).toBe(2)
    })
  })
})

// ---------------------------------------------------------------------------
// The workflow ([9], [5])
// ---------------------------------------------------------------------------

describe('the Production workflow', () => {
  it('pins every third-party action to a full commit, and flyctl to a version, in the worker job alone', () => {
    // The `uses:` keys, not the word in a comment.
    const uses = [...yml.matchAll(/^ +(?:- )?uses: (\S+)/gm)].map((m) => m[1]!)
    expect(uses).toContain('actions/checkout@v4')
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses.filter((x) => !x.startsWith('actions/'))) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
    for (const [id, job] of jobs) {
      const fly = stepsOf(job).filter((s) => s.includes('setup-flyctl'))
      if (id !== 'worker') {
        expect(fly, id).toEqual([])
        continue
      }
      expect(fly).toHaveLength(1)
      expect(fly[0]).toMatch(/\n {10}version: \d+\.\d+\.\d+(\n|$)/)
    }
  })

  it('runs the worker action as two jobs, the web one after the worker one and skipped only on a `false` that arrived', () => {
    expect([...jobs.keys()]).toEqual(['production', 'worker', 'worker-web'])
    expect(jobOf('production')).toMatch(/^ {4}if: inputs\.action != 'worker'$/m)
    expect(jobOf('worker')).toMatch(/^ {4}if: inputs\.action == 'worker'$/m)
    const web = jobOf('worker-web')
    expect(web).toMatch(/^ {4}needs: worker$/m)
    expect(web).toMatch(/^ {4}if: needs\.worker\.outputs\.redeploy != 'false'$/m)
    // The one output: a word, never the marker.
    const outputs = /^ {4}outputs:\n((?: {6}.*\n)+)/m.exec(jobOf('worker'))?.[1] ?? ''
    expect(outputs).toBe('      redeploy: ${{ steps.worker.outputs.redeploy }}\n')
    expect(stepsOf(jobOf('worker')).filter((s) => s.includes('id: worker\n'))).toHaveLength(1)
    // Each job runs its own action, and no input can name the web job's.
    expect(scriptStepOf(jobOf('production'))).toContain('run: tools/production.sh "$ACTION"\n')
    expect(scriptStepOf(jobOf('worker'))).toContain('run: tools/production.sh worker\n')
    expect(scriptStepOf(web)).toContain('run: tools/production.sh worker-web\n')
    expect(/options: \[([^\]]*)\]/.exec(yml)?.[1]).toBe('status, migrate, deploy, release, worker')
  })

  it('hands the worker’s own secrets to the worker job’s script step alone, and the web job VERCEL_* alone', () => {
    // A secret named anywhere in a job — even in a `!= ''` that yields a
    // boolean — has its value sent to that job's runner. Only the worker
    // job may name one of the worker's, and only its script step is handed
    // a value; its visibility step asks whether FLY_API_TOKEN is set.
    for (const [id, job] of jobs) {
      if (id !== 'worker') {
        for (const name of WORKER_ONLY) expect(job, `${name} in ${id}`).not.toMatch(new RegExp(`\\b${name}\\b`))
        continue
      }
      for (const step of stepsOf(job).filter((s) => s !== scriptStepOf(job))) {
        for (const m of step.matchAll(/\$\{\{ secrets\.([A-Z_]+)([^}]*)\}\}/g)) {
          if (WORKER_ONLY.includes(m[1]!)) expect(m[2], `${m[1]} handed to a step that is not worker's script`).toBe(" != '' ")
        }
      }
    }
    expect(new Set(secretsReferencedBy(jobOf('production')))).toEqual(new Set(['PRODUCTION_DATABASE_URL', ...VERCEL_SECRETS]))
    expect(new Set(envOf(scriptStepOf(jobOf('production'))))).toEqual(new Set(['ACTION', 'PRODUCTION_DATABASE_URL', ...VERCEL_SECRETS]))
    // Exactly the database, Vercel for our own REST helpers, and WORKER_ONLY,
    // which production.sh strips from everything but flyctl ([6]).
    expect(new Set(envOf(scriptStepOf(jobOf('worker'))))).toEqual(new Set([...WORKER_ONLY, 'PRODUCTION_DATABASE_URL', ...VERCEL_SECRETS]))
    // The web job: Vercel's and nothing else, anywhere in the job — not even
    // the database URL, which it does not need.
    const web = jobOf('worker-web')
    expect(new Set(envOf(scriptStepOf(web)))).toEqual(new Set(VERCEL_SECRETS))
    expect(new Set(secretsReferencedBy(web))).toEqual(new Set(VERCEL_SECRETS))
  })

  it('every job confirms the action, runs in the production environment, and says where its credentials are visible', () => {
    for (const [id, job] of jobs) {
      expect(job, id).toMatch(/^ {4}environment: production$/m)
      const steps = stepsOf(job)
      const confirm = steps.find((s) => s.startsWith('name: Refuse an unconfirmed change'))
      expect(confirm, id).toContain("if: inputs.action != 'status' && inputs.confirm != inputs.action")
      const visible = steps.find((s) => /^name: Which credentials this (run|job) can see/.test(s))
      expect(visible, id).toContain('TOKEN_VARIABLE: ${{ vars.VERCEL_TOKEN != \'\' }}')
      // Both run before anything is checked out or installed.
      const first = steps.findIndex((s) => s.includes('actions/checkout'))
      expect(steps.indexOf(confirm!), id).toBeLessThan(first)
      expect(steps.indexOf(visible!), id).toBeLessThan(first)
    }
  })
})
