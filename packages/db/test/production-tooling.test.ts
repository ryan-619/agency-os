/**
 * The Production workflow's `worker` action (tools/production.sh,
 * tools/vercel-env.mjs, .github/workflows/production.yml), driven against
 * stubs: a `flyctl`, `npx` (tsc and the Vercel CLI), `curl` and `sleep` on
 * PATH, a `node` in front of the real one, and stand-ins for the repo's own
 * helper scripts in a scratch copy of the layout the script reads — so the
 * REAL script runs, and nothing it calls reaches Fly, Vercel, a database or
 * the network.
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
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = resolve(root, 'tools/production.sh')
const vercelEnv = resolve(root, 'tools/vercel-env.mjs')
const EXPECTED = /EXPECTED_MIGRATION = '(\d+)'/.exec(readFileSync(resolve(root, 'packages/db/src/schema-version.ts'), 'utf8'))![1]!
const PASSWORD = 'db-password-never-printed-5521'
const APP = 'agency-os-agent'

/**
 * The worker step's own secrets (.github/workflows/production.yml), which
 * production.sh's WORKER_ONLY must list exactly: the workflow hands them to
 * the `worker` step alone, and the script hands them to flyctl alone.
 */
const WORKER_ONLY = [
  'FLY_API_TOKEN', 'FLY_ORG', 'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'AGENT_MODEL', 'SECRETS_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'MAIL_FROM',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASSWORD', 'IMAP_SECURE', 'IMAP_MAILBOX',
  'SLACK_WEBHOOK_URL', 'UNSUBSCRIBE_SECRET', 'DOVESOFT_API_KEY', 'DOVESOFT_ENTITY_ID',
]
/** What Fly is handed over stdin: everything but Fly's own two, which are flyctl's. */
const STAGED = WORKER_ONLY.filter((n) => n !== 'FLY_API_TOKEN' && n !== 'FLY_ORG')
/** A value no output may carry, for each. */
const secretOf = (name: string) => `${name.toLowerCase()}-value-never-printed-8813`

/** Fly's digest, as the stub computes it: a hash of the value, never the value. */
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)

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
const digest = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16)
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
 * `npx`: \`tsc --build\` does nothing; the Vercel CLI's pull, build and deploy
 * are recorded. A pull writes the project's DATABASE_URL, as `vercel pull`
 * does where it is not Sensitive.
 */
const NPX = `#!/usr/bin/env bash
${RECORD}
record "npx $*"
echo "npx $*" >>"$STUB_STATE/calls.log"
if [ "$1" = tsc ]; then exit 0; fi
case " $* " in
  *" pull "*) mkdir -p .vercel && echo "DATABASE_URL=postgres://owner:${PASSWORD}@db.example/neondb" >.vercel/.env.production.local ;;
  *" build "*) mkdir -p .vercel/output/functions ;;
  *" deploy "*) [ -e "$STUB_STATE/web-deploy-fails" ] && exit 1 ;;
esac
exit 0
`

/** `curl`: the worker answers /readyz, and the site reports the checkout's schema and a live worker. */
const CURL = `#!/usr/bin/env bash
${RECORD}
record curl
url="\${@: -1}"
case "$*" in
  *"%{http_code}"*) printf 200 ;;
  *"/api/health?strict=1"*) printf '{"database":"ok","schema":{"expected":"%s","applied":"%s"}}' "$EXPECTED" "$EXPECTED" ;;
  *"/api/health"*) printf '{"database":"ok","worker":{"status":"live"}}' ;;
  *) exit 7 ;;
esac
`

/** tools/vercel-env.mjs's stand-in: production variables in a JSON file; an API error on request. */
const VERCEL_ENV_STUB = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const state = process.env.STUB_STATE
const [cmd, key] = process.argv.slice(2)
fs.appendFileSync(path.join(state, 'calls.log'), 'vercel-env ' + cmd + ' ' + key + '\\n')
if (fs.existsSync(path.join(state, 'vercel-api-down'))) { console.error('::error::listing the project’s variables failed: HTTP 500'); process.exit(2) }
const file = path.join(state, 'vercel-vars.json')
const vars = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
if (cmd === 'has') process.exit(key in vars ? 0 : 1)
if (cmd === 'equals') process.exit(vars[key] === process.env.VALUE ? 0 : 1)
if (cmd === 'set') { vars[key] = process.env.VALUE; fs.writeFileSync(file, JSON.stringify(vars)); console.log('vercel: ' + key + ' set'); process.exit(0) }
process.exit(2)
`

/** tools/production-env.mjs's stand-in: the database URL comes from the secret, else from the pulled file. */
const PRODUCTION_ENV_STUB = `#!/usr/bin/env node
import fs from 'node:fs'
const [cmd, file, out] = process.argv.slice(2)
const pulled = () => /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(file, 'utf8'))[1]
if (cmd === 'database-url') fs.writeFileSync(out, process.env.PRODUCTION_DATABASE_URL ?? pulled())
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

interface Run {
  readonly status: number | null
  readonly out: string
  readonly calls: string[]
}

describe('the worker action', () => {
  let dir: string
  let state: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'production-tooling-'))
    state = join(dir, 'state')
    for (const d of ['bin', 'tools', 'packages/db/src', 'packages/db/dist', 'state', 'runner']) mkdirSync(join(dir, d), { recursive: true })
    const exe = (path: string, body: string) => {
      writeFileSync(join(dir, path), body)
      chmodSync(join(dir, path), 0o755)
    }
    exe('bin/node', NODE)
    exe('bin/flyctl', FLYCTL_LAUNCHER)
    writeFileSync(join(dir, 'flyctl.js'), FLYCTL)
    exe('bin/npx', NPX)
    exe('bin/curl', CURL)
    exe('bin/sleep', '#!/usr/bin/env bash\nexit 0\n')
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

  /** Run `worker`; `extra` adds to the environment, and an `undefined` takes a name out of it. */
  function run(extra: Record<string, string | undefined> = {}): Run {
    rmSync(join(state, 'calls.log'), { force: true })
    writeFileSync(join(state, 'calls.log'), '')
    writeFileSync(join(state, 'env.log'), '')
    const env: Record<string, string | undefined> = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? dir,
      STUB_STATE: state,
      REAL_NODE: process.execPath,
      EXPECTED,
      RUNNER_TEMP: join(dir, 'runner'),
      PRODUCTION_URL: 'https://site.example',
      PRODUCTION_DATABASE_URL: `postgres://owner:${PASSWORD}@db.example/neondb`,
      VERCEL_TOKEN: 'vercel-token-stub',
      VERCEL_ORG_ID: 'team_stub',
      VERCEL_PROJECT_ID: 'prj_stub',
      FLY_API_TOKEN: 'fly-token-stub',
      ...extra,
    }
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
    const r = spawnSync('bash', [script, 'worker'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 })
    const calls = readFileSync(join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean)
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls }
  }

  const staged = (r: Run) => r.calls.filter((c) => c.startsWith('flyctl secrets import'))
  const flyDeploys = (r: Run) => r.calls.filter((c) => c.startsWith('flyctl deploy'))
  const webDeploys = (r: Run) => r.calls.filter((c) => /^npx .*vercel@\S+ deploy /.test(c))
  const vercelSets = (r: Run) => r.calls.filter((c) => c.startsWith('vercel-env set'))

  /** Both sides agree, as a run that finished leaves them. */
  const wired = (token = 'a'.repeat(64)) => {
    setFly({ DATABASE_URL: 'x', AGENT_INTERNAL_TOKEN: token })
    setVercel({
      AGENT_URL: `https://${APP}.fly.dev`,
      AGENT_INTERNAL_TOKEN: token,
      AGENT_INTERNAL_TOKEN_WIRED: `${APP}:${digestOf(token)}`,
    })
  }

  /** The two sides hold one token, and the live web app was deployed with it. */
  const expectWiredTogether = () => {
    const fly = flySecrets()
    const vercel = vercelVars()
    expect(fly.AGENT_INTERNAL_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(vercel.AGENT_INTERNAL_TOKEN).toBe(fly.AGENT_INTERNAL_TOKEN)
    expect(vercel.AGENT_URL).toBe(`https://${APP}.fly.dev`)
    expect(vercel.AGENT_INTERNAL_TOKEN_WIRED).toBe(`${APP}:${digestOf(fly.AGENT_INTERNAL_TOKEN!)}`)
  }

  it('wires a fresh app: one token on both sides, the web app redeployed, and the record written LAST', () => {
    const r = run()
    expect(r.status, r.out).toBe(0)
    expectWiredTogether()
    expect(webDeploys(r)).toHaveLength(1)
    const marker = r.calls.indexOf('vercel-env set AGENT_INTERNAL_TOKEN_WIRED')
    expect(marker).toBeGreaterThan(r.calls.indexOf(webDeploys(r)[0]!))
    expect(r.out).toContain('live: https://site.example/api/health reports the worker live')
    expect(r.out).not.toContain(PASSWORD)
  })

  it('keeps a wiring a finished run recorded: no new token, nothing set on Vercel, no web deploy', () => {
    wired()
    const r = run()
    expect(r.status, r.out).toBe(0)
    expect(staged(r)).toHaveLength(1)
    expect(flySecrets().AGENT_INTERNAL_TOKEN).toBe('a'.repeat(64))
    expect(vercelSets(r)).toEqual([])
    expect(webDeploys(r)).toEqual([])
    expect(flyDeploys(r)).toHaveLength(1)
  })

  describe('a Vercel API error is not "absent" ([10])', () => {
    it('stops the run before a token is generated or anything is staged', () => {
      wired()
      flag('vercel-api-down')
      const r = run()
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/Could not read the Vercel project's variables/)
      expect(staged(r)).toEqual([])
      expect(flyDeploys(r)).toEqual([])
      expect(webDeploys(r)).toEqual([])
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
        AGENT_INTERNAL_TOKEN_WIRED: `${APP}:${digestOf('a'.repeat(64))}`,
      })
      const r = run()
      expect(r.status, r.out).toBe(0)
      expect(staged(r)).toHaveLength(1)
      expect(flySecrets().AGENT_INTERNAL_TOKEN).not.toBe('b'.repeat(64))
      expectWiredTogether()
      expect(webDeploys(r)).toHaveLength(1)
    })

    it('Vercel set and the web app never redeployed: the failed run records nothing, and the next one redeploys', () => {
      flag('web-deploy-fails')
      const first = run()
      expect(first.status).not.toBe(0)
      expect(vercelVars().AGENT_INTERNAL_TOKEN).toBe(flySecrets().AGENT_INTERNAL_TOKEN)
      expect(vercelVars().AGENT_INTERNAL_TOKEN_WIRED).toBeUndefined()

      flag('web-deploy-fails', false)
      const second = run()
      expect(second.status, second.out).toBe(0)
      expect(webDeploys(second)).toHaveLength(1)
      expectWiredTogether()
    })

    it('a Fly deploy that failed after a new token was staged: the next run wires both sides again', () => {
      wired()
      // A token that was never wired, staged by a run whose deploy failed.
      setFly({ DATABASE_URL: 'x', AGENT_INTERNAL_TOKEN: 'c'.repeat(64) })
      flag('fly-deploy-fails')
      expect(run().status).not.toBe(0)
      flag('fly-deploy-fails', false)
      const r = run()
      expect(r.status, r.out).toBe(0)
      expectWiredTogether()
      expect(webDeploys(r)).toHaveLength(1)
    })

    it('a record for another app is not a record for this one', () => {
      wired()
      setVercel({ ...vercelVars(), AGENT_INTERNAL_TOKEN_WIRED: `${APP}-old:${digestOf('a'.repeat(64))}` })
      const r = run()
      expect(r.status, r.out).toBe(0)
      expectWiredTogether()
    })
  })

  describe('the worker’s secrets reach flyctl alone ([6])', () => {
    interface Seen {
      readonly who: string
      readonly names: readonly string[]
    }
    /** What each process this run started had in its environment, by name. */
    const seen = (): Seen[] =>
      readFileSync(join(state, 'env.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [who = '', names = ''] = line.split('\t')
          return { who, names: names.split(' ').filter(Boolean) }
        })
    const leaked = (s: Seen) => s.names.filter((n) => WORKER_ONLY.includes(n))
    const everySecret = Object.fromEntries(WORKER_ONLY.map((n) => [n, secretOf(n)]))

    /** Nothing but flyctl saw a worker secret, and flyctl saw FLY_API_TOKEN and nothing else of them. */
    function expectContained(r: Run) {
      expect(r.status, r.out).toBe(0)
      const all = seen()
      const fly = all.filter((s) => s.who.startsWith('flyctl '))
      const rest = all.filter((s) => !s.who.startsWith('flyctl '))
      for (const s of rest) expect(leaked(s), s.who).toEqual([])
      expect(fly.length).toBeGreaterThan(0)
      for (const s of fly) expect(leaked(s), s.who).toEqual(['FLY_API_TOKEN'])
      // Fly was still handed every one, over stdin, with its value.
      const onFly = flySecrets()
      for (const n of STAGED) expect(onFly[n], n).toBe(secretOf(n))
      expect(onFly.FLY_API_TOKEN).toBeUndefined()
      expect(onFly.FLY_ORG).toBeUndefined()
      for (const n of WORKER_ONLY) expect(r.out, n).not.toContain(secretOf(n))
      return all
    }
    const whos = (all: Seen[]) => all.map((s) => s.who)

    it('on a wiring run: the Vercel CLI’s pull, build and deploy, and every helper of ours, see none of them', () => {
      const all = expectContained(run(everySecret))
      const vercel = whos(all).filter((w) => /^npx --yes vercel@\S+ /.test(w))
      // Not vacuous: the run did reach every Vercel CLI call and every helper.
      for (const verb of ['pull', 'build', 'deploy']) expect(vercel.some((w) => w.includes(` ${verb} `)), verb).toBe(true)
      for (const helper of ['node vercel-env.mjs', 'node production-env.mjs', 'node cli.js', 'node -e', 'npx tsc --build', 'curl']) {
        expect(whos(all), helper).toContain(helper)
      }
      expect(whos(all).some((w) => w.startsWith('flyctl secrets import'))).toBe(true)
      expect(whos(all).some((w) => w.startsWith('flyctl deploy'))).toBe(true)
    })

    it('when the database URL and the project ids come from Vercel: the pull BEFORE staging sees none of them either', () => {
      const all = expectContained(run({ ...everySecret, PRODUCTION_DATABASE_URL: undefined, VERCEL_ORG_ID: undefined, VERCEL_PROJECT_ID: undefined }))
      const pull = whos(all).findIndex((w) => /^npx --yes vercel@\S+ pull /.test(w))
      expect(pull).toBeGreaterThan(-1)
      expect(pull).toBeLessThan(whos(all).findIndex((w) => w.startsWith('flyctl secrets import')))
      expect(whos(all)).toContain('node vercel-project.mjs')
    })

    it('on a run that keeps the wiring: no Vercel CLI call, and flyctl still gets its token', () => {
      wired()
      const all = expectContained(run(everySecret))
      expect(whos(all).filter((w) => w.startsWith('npx --yes vercel@'))).toEqual([])
      expect(whos(all).filter((w) => w.startsWith('flyctl ')).length).toBeGreaterThan(2)
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
        env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, STUB_STATE: state, ...everySecret },
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      const vercel = seen().filter((s) => s.who.startsWith('npx --yes vercel@'))
      expect(vercel).toHaveLength(1)
      expect(leaked(vercel[0]!)).toEqual([])
    })

    it('lists exactly the worker step’s own secrets, so a new one cannot be staged without being stripped', () => {
      const body = readFileSync(script, 'utf8')
      const array = /^WORKER_ONLY=\(([^)]*)\)/m.exec(body)?.[1] ?? ''
      const names = array.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean)
      expect(new Set(names)).toEqual(new Set(WORKER_ONLY))
      expect(names).toHaveLength(WORKER_ONLY.length)
    })
  })

  describe('the schema comes first ([11], [17])', () => {
    it('refuses — before anything is created, staged or deployed — when production lacks the checkout’s migration', () => {
      applied(String(Number(EXPECTED) - 1).padStart(4, '0'))
      const r = run()
      expect(r.status).not.toBe(0)
      expect(r.out).toContain(`Production has not applied migration ${EXPECTED}`)
      expect(r.out).toMatch(/Run the 'release' action from this ref first/)
      expect(r.calls.filter((c) => c.startsWith('flyctl'))).toEqual([])
      expect(r.calls.filter((c) => c.startsWith('vercel-env'))).toEqual([])
      expect(webDeploys(r)).toEqual([])
      expect(r.out).not.toContain(PASSWORD)
    })

    it('never migrates: the one place that migrates is `release`', () => {
      const r = run()
      expect(r.status, r.out).toBe(0)
      expect(r.calls.filter((c) => /cli\.js up|db:migrate/.test(c))).toEqual([])
      const body = readFileSync(script, 'utf8')
      const worker = body.slice(body.indexOf('\nworker() {'), body.indexOf('\n}\n', body.indexOf('\nworker() {')))
      expect(worker).not.toMatch(/\bmigrate\b|db up/)
      expect(worker.indexOf('schema_ready')).toBeGreaterThan(-1)
      expect(worker.indexOf('schema_ready')).toBeLessThan(worker.indexOf('fly_app'))
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

  /** Run the real script with `fetch` answering from `routes` (path prefix → [status, body]). */
  function run(args: string[], routes: Record<string, [number, unknown]>, value?: string) {
    const hook = join(dir, 'fetch.mjs')
    writeFileSync(
      hook,
      `const routes = ${JSON.stringify(routes)}
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname
  const hit = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0]
  const [status, body] = hit ? routes[hit] : [404, {}]
  return new Response(JSON.stringify(body), { status })
}
`,
    )
    const r = spawnSync(process.execPath, ['--import', hook, vercelEnv, ...args], {
      env: { PATH: process.env.PATH ?? '', VERCEL_TOKEN: 't', VERCEL_ORG_ID: 'team_x', VERCEL_PROJECT_ID: 'prj', ...(value ? { VALUE: value } : {}) },
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  const list = { envs: [{ id: 'env_1', key: 'AGENT_INTERNAL_TOKEN_WIRED', target: ['production'], type: 'encrypted' }] }

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
    const same = run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, 'agency-os-agent:0123abcd'), 'agency-os-agent:0123abcd')
    expect(same.status).toBe(0)
    expect(same.out).not.toContain('0123abcd')
    const other = run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(200, 'agency-os-agent:ffff'), 'agency-os-agent:0123abcd')
    expect(other.status).toBe(1)
    expect(other.out).not.toContain('ffff')
    expect(run(['equals', 'AGENT_URL'], routes(200, 'x'), 'x').status).toBe(1)
    expect(run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], routes(500, null), 'x').status).toBe(2)
    expect(run(['equals', 'AGENT_INTERNAL_TOKEN_WIRED'], { '/v10/projects/prj/env': [403, {}] }, 'x').status).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// The workflow ([9])
// ---------------------------------------------------------------------------

describe('the Production workflow', () => {
  const yml = readFileSync(resolve(root, '.github/workflows/production.yml'), 'utf8')
  const steps = yml
    .slice(yml.indexOf('    steps:\n'))
    .split(/\n {6}- /)
    .slice(1)
  const envOf = (step: string) => [...step.matchAll(/^ {10}([A-Z_]+): /gm)].map((m) => m[1]!)

  it('pins every third-party action to a full commit, and flyctl to a version', () => {
    const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses.filter((x) => !x.startsWith('actions/'))) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
    const fly = steps.find((s) => s.includes('setup-flyctl'))!
    expect(fly).toMatch(/\n {10}version: \d+\.\d+\.\d+\n/)
    expect(fly).toContain("if: inputs.action == 'worker'")
  })

  it('hands the worker’s own secrets only to a step that runs for `worker`', () => {
    const withSecrets = steps.filter((s) => s.includes('secrets.'))
    for (const step of withSecrets) {
      const env = envOf(step)
      if (step.includes("if: inputs.action == 'worker'")) continue
      for (const name of WORKER_ONLY) expect(env, `${name} in a step that runs for every action`).not.toContain(name)
    }
    const others = withSecrets.filter((s) => s.includes("if: inputs.action != 'worker'"))
    expect(others).toHaveLength(1)
    expect(new Set(envOf(others[0]!))).toEqual(
      new Set(['ACTION', 'PRODUCTION_DATABASE_URL', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM']),
    )
    const worker = withSecrets.filter((s) => s.includes("if: inputs.action == 'worker'") && s.includes('production.sh'))
    expect(worker).toHaveLength(1)
    // Exactly the other step's credentials plus WORKER_ONLY, which
    // production.sh strips from everything but flyctl ([6]): a secret added
    // here and not there would reach the Vercel CLI.
    expect(new Set(envOf(worker[0]!))).toEqual(
      new Set([...WORKER_ONLY, 'PRODUCTION_DATABASE_URL', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM']),
    )
  })
})
