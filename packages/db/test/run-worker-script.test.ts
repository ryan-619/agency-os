/**
 * tools/run-worker.sh — the worker on the operator's own machine, the
 * deployment for an agency that has not rented a server.
 *
 * It is driven here against stubs: `uname` (to read as a Mac, or not),
 * `security` (a Keychain kept in files), `caffeinate` (runs its command),
 * `node` (in front of the real one, for the version check), `pbcopy` (keeps
 * what it was handed, so a test can compare it), the lockfile's
 * `node_modules/.bin/tsc` and `tsx` (each records what it was asked to run
 * and the NAMES and values in its environment, then stops), and an `npx`
 * that records being run at all — which it never may be. So the REAL script
 * runs, and nothing reaches a database, a mailbox or the network.
 *
 * The prompts need a terminal. Where util-linux's `script` is installed (CI's
 * Ubuntu), the questions are answered through a pseudo-terminal it opens,
 * with echo off so a typed secret never reaches the transcript, one answer
 * per prompt as it appears; elsewhere only the saved-answer path runs.
 *
 * What is pinned:
 *  - a saved answer reaches the worker's ENVIRONMENT, never any process's
 *    argument list (§2.3: `ps` shows argv to every user on the machine) —
 *    the Keychain stub records every argv it is given;
 *  - port 465 is implicit TLS (`SMTP_SECURE=true`), anything else STARTTLS;
 *  - the packages are built before the worker starts, because they run as
 *    compiled JavaScript and a fresh checkout or a `git pull` would otherwise
 *    run stale code or none — and built BEFORE any answer is read, with the
 *    lockfile's tsc and tsx by path, never npx, which runs whatever the
 *    registry holds under a name it cannot find locally (review round 9,
 *    [9]); a checkout without them is told to run `npm ci`;
 *  - the UNSUBSCRIBE_SECRET is never made up on a key press (review round 9,
 *    [2] and [7]): Enter keeps the saved one or sends no header, a new one is
 *    made only when typed for, confirmed, and only where it can be put on the
 *    clipboard AND saved — never off a Mac — and a secret saved before
 *    survives a reconfigure that turns sending off;
 *  - chat runs only with a tunnel: an ngrok stub stands in for ngrok, which is
 *    started from an EMPTY environment (no credential reaches a third
 *    party's binary), with the domain on its argv, its request inspector
 *    off, and nothing secret; chat is ON only once ngrok says the tunnel on
 *    that domain started, ngrok is stopped when the worker exits, and a
 *    tunnel an earlier run left on the port is stopped; the worker gets the
 *    Anthropic key and the saved AGENT_INTERNAL_TOKEN only when chat is on,
 *    never a value exported in the shell, and the token is made on a key
 *    press only onto the clipboard and into the Keychain — never over an
 *    unsubscribe secret still waiting to be pasted — and a saved one can be
 *    copied again or replaced;
 *  - a server name is asked until it is one, and Google's IMAP username until
 *    it is a whole address;
 *  - a run refuses, before it builds, asks or stops any tunnel, while either
 *    of the worker's ports already answers — a second run typed beside a
 *    live worker stopped its tunnel and then died on its ports;
 *  - a saved SECRETS_KEY reaches the worker, so a connector's encrypted key
 *    can be read; `--secrets-key` asks for it alone, refuses anything that is
 *    not base64 of 32 bytes, and a `--reconfigure` keeps a saved one;
 *  - `--ai` asks whether a model sorts replies and polishes openers, saves
 *    the choice, and the worker gets it only on a chat-on run, which is the
 *    one that hands it the Anthropic key; a `--reconfigure` keeps it;
 *  - `--imap` asks reply detection's three questions alone, over the saved
 *    answers — a new Google app password, saved without the spaces Google
 *    shows it with — and keeps every other saved answer as it was;
 *  - Neon's pooled endpoint is refused, saved or not;
 *  - `--forget` removes every saved answer.
 */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = resolve(root, 'tools/run-worker.sh')

const DB = 'postgresql://owner:db-password-never-in-argv-77@ep-quiet-sky-123.us-east-1.aws.neon.tech/agency'
const SMTP_PASSWORD = 're_smtp_key_never_in_argv_31'
const IMAP_PASSWORD = 'imap-app-password-never-in-argv'
const UNSUB = 'u'.repeat(64)
const VERCEL_UNSUB = 'v'.repeat(64)
const FROM = 'Agency <hello@myagencyos.in>'
const ANTHROPIC_KEY = 'sk-ant-api03-key-never-in-argv-or-ngrok'
const CHAT_TOKEN = 't'.repeat(64)
const CHAT_DOMAIN = 'calm-otter-42.ngrok-free.app'
/** What `openssl rand -base64 32` makes: base64 of 32 bytes, as the worker's masterKey() requires. */
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')
/**
 * The script stops any ngrok tunnel on the worker's API port before it opens
 * its own, and every test here runs the real script — on the operator's own
 * machine as well, where the live worker's tunnel sits on the default port,
 * 3002. One local run of this file killed it, and chat on the live site with
 * it. So every run here puts the worker on ports nothing real uses.
 */
const AGENT_PORT = '39401'
const API_PORT = '39402'
/** What the worker's build and run must never be handed before the operator has answered anything. */
const CREDENTIALS = [
  'DATABASE_URL', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'UNSUBSCRIBE_SECRET', 'SLACK_WEBHOOK_URL', 'DOVESOFT_API_KEY',
  'ANTHROPIC_API_KEY', 'AGENT_INTERNAL_TOKEN', 'SECRETS_KEY',
]

let dir: string
let bin: string
let keychain: string
let logs: string

function stub(name: string, body: string): void {
  const path = join(bin, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/**
 * The lockfile's tsc or tsx: record the argv on one line — the tool's name
 * first — then every NAME=value, then stop.
 */
const LOCAL_BIN = '{ printf "%s %s\\n" "$(basename "$0")" "$*"; env; printf "\\n\\0\\n"; } >> "$LOGS/run"; exit 0'

/** A checkout the script can `cd` into: tools/run-worker.sh and a node_modules with its two tools. */
function layout(): string {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'tools'), { recursive: true })
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(repo, 'tools/run-worker.sh'), readFileSync(script))
  chmodSync(join(repo, 'tools/run-worker.sh'), 0o755)
  for (const tool of ['tsc', 'tsx']) {
    writeFileSync(join(repo, 'node_modules/.bin', tool), `#!/usr/bin/env bash\n${LOCAL_BIN}\n`)
    chmodSync(join(repo, 'node_modules/.bin', tool), 0o755)
  }
  return repo
}

function save(name: string, value: string): void {
  writeFileSync(join(keychain, name), Buffer.from(value).toString('base64'))
}

/** What the Keychain stub holds for `name`, decoded; undefined when nothing is saved. */
function saved(name: string): string | undefined {
  const file = join(keychain, name)
  return existsSync(file) ? Buffer.from(readFileSync(file, 'utf8').trim(), 'base64').toString() : undefined
}

/** What pbcopy was last handed; undefined when it never ran. */
function clipboard(): string | undefined {
  const file = join(logs, 'clipboard')
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/** Whether anything ran npx — which nothing may. */
const npxRan = () => existsSync(join(logs, 'npx'))

function run(repo: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(repo, 'tools/run-worker.sh'), ...args], {
    cwd: repo,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, KEYCHAIN: keychain, LOGS: logs, AGENT_PORT, ...extra },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

/**
 * ngrok: records its argv, its environment and its pid, says on stdout — the
 * script's log of it — what the real agent says once a tunnel is up, then
 * stays up as a tunnel does. `line` replaces that saying (an error that
 * retries for ever, say). The log path is written in, because ngrok is
 * started from an empty environment and $LOGS does not reach it.
 */
function ngrokStub(line = `t=2026-10-06T00:00:00+0000 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://127.0.0.1:${API_PORT} url=https://${CHAT_DOMAIN}`): void {
  stub('ngrok', [
    `printf "%s\\n" "$*" >> "${logs}/ngrok-argv"`,
    `env > "${logs}/ngrok-env"`,
    `echo $$ > "${logs}/ngrok-pid"`,
    `printf '%s\\n' '${line}'`,
    'exec sleep 30',
  ].join('\n'))
}

/** Whether `pid` is gone within `ms`, polled — the watcher checks every two seconds. */
function goneWithin(pid: number, ms: number): boolean {
  const until = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > until) return false
    spawnSync('sleep', ['0.2'])
  }
}

const ngrokPid = (): number => Number(readFileSync(join(logs, 'ngrok-pid'), 'utf8').trim())

/** Whether a child of this process has exited within `ms`, by its own exit event. */
function exitedWithin(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function calls(): { argv: string; env: Record<string, string> }[] {
  if (!existsSync(join(logs, 'run'))) return []
  return readFileSync(join(logs, 'run'), 'utf8').trim().split('\n\0\n').filter(Boolean).map((block) => {
    const [argv, ...env] = block.split('\n')
    return { argv: argv!, env: Object.fromEntries(env.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-worker-'))
  bin = join(dir, 'bin')
  keychain = join(dir, 'keychain')
  logs = join(dir, 'logs')
  for (const d of [bin, keychain, logs]) mkdirSync(d)

  stub('uname', 'echo Darwin')
  // The Keychain: find prints the stored base64; delete removes it; `-i`
  // reads `add-generic-password … -a NAME -w BASE64` lines on STDIN. Every
  // argv it is ever given is appended to a log the tests read.
  stub('security', [
    'printf "%s\\n" "$*" >> "$LOGS/security-argv"',
    'case "$1" in',
    '  find-generic-password) a=""; while [ $# -gt 0 ]; do [ "$1" = -a ] && a="$2"; shift; done',
    '    [ -f "$KEYCHAIN/$a" ] || exit 44; cat "$KEYCHAIN/$a"; echo ;;',
    '  delete-generic-password) a=""; while [ $# -gt 0 ]; do [ "$1" = -a ] && a="$2"; shift; done; rm -f "$KEYCHAIN/$a" ;;',
    '  -i) while read -r cmd rest; do set -- $rest; a=""; w=""',
    '      while [ $# -gt 0 ]; do case "$1" in -a) a="$2";; -w) w="$2";; esac; shift; done',
    '      printf "%s" "$w" > "$KEYCHAIN/$a"; done ;;',
    'esac',
  ].join('\n'))
  stub('caffeinate', 'shift; exec "$@"')
  // The version check is the only thing that asks node; answer it as 22,
  // whatever node this machine has first on PATH.
  stub('node', `case "$1" in -p) echo 22 ;; -v) echo v22.0.0 ;; *) exec "${process.execPath}" "$@" ;; esac`)
  stub('pbcopy', 'cat > "$LOGS/clipboard"')
  // npx: never to be run. It records that it was, and stops.
  stub('npx', 'printf "%s\\n" "$*" >> "$LOGS/npx"; exit 0')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('tools/run-worker.sh', () => {
  it('passes the shell syntax check', () => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0)
  })

  it('runs the worker on the saved answers, in its environment and never on an argument list', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    save('SMTP_HOST', 'smtp.resend.com')
    save('SMTP_PORT', '465')
    save('SMTP_USER', 'resend')
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    save('MAIL_FROM', 'Agency <hello@myagencyos.in>')
    save('IMAP_HOST', 'imap.gmail.com')
    save('IMAP_USER', 'hello@myagencyos.in')
    save('IMAP_PASSWORD', IMAP_PASSWORD)
    save('WEB_PUBLIC_URL', 'https://myagencyos.in')
    save('UNSUBSCRIBE_SECRET', UNSUB)

    const r = run(repo)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Using the answers saved in your Keychain')
    expect(r.stdout).toContain('sending:  ON')
    expect(r.stdout).toContain('with a one-click unsubscribe link to https://myagencyos.in')
    expect(r.stdout).toContain('replies:  ON')

    const c = calls()
    // Built first, then the worker — both the lockfile's own, by path, and
    // never npx (round 9, [9]).
    expect(c.map((x) => x.argv)).toEqual(['tsc --build', 'tsx apps/agent/src/index.ts'])
    expect(npxRan()).toBe(false)
    // The build ran before a single answer was read: it holds none of them.
    for (const name of CREDENTIALS) expect(c[0]!.env[name], name).toBeUndefined()
    const worker = c[1]!.env
    expect(worker.DATABASE_URL).toBe(DB)
    expect(worker.SMTP_PASSWORD).toBe(SMTP_PASSWORD)
    expect(worker.IMAP_PASSWORD).toBe(IMAP_PASSWORD)
    expect(worker.UNSUBSCRIBE_SECRET).toBe(UNSUB)
    expect(worker.SMTP_SECURE).toBe('true')
    expect(worker.IMAP_PORT).toBe('993')
    expect(worker.NODE_ENV).toBe('production')
    expect(worker.AGENT_BIND).toBe('127.0.0.1')
    expect(worker.AGENT_INTERNAL_TOKEN?.length).toBeGreaterThanOrEqual(32)

    // No secret on any argument list: not npx's, not the Keychain's.
    const argvs = [...c.map((x) => x.argv), readFileSync(join(logs, 'security-argv'), 'utf8')].join('\n')
    for (const secret of [DB, 'db-password-never-in-argv-77', SMTP_PASSWORD, IMAP_PASSWORD, UNSUB]) {
      expect(argvs).not.toContain(secret)
    }
    // …and nothing the script printed carries one.
    for (const secret of ['db-password-never-in-argv-77', SMTP_PASSWORD, IMAP_PASSWORD, UNSUB]) {
      expect(r.stdout + r.stderr).not.toContain(secret)
    }
  })

  it('is STARTTLS on any port but 465', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    save('SMTP_HOST', 'smtp.example.com')
    save('SMTP_PORT', '587')
    save('MAIL_FROM', 'x@example.com')
    expect(run(repo).status).toBe(0)
    expect(calls()[1]!.env.SMTP_SECURE).toBe('false')
  })

  it('says sending is off, and starts no mailbox, without a From', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    const r = run(repo)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('sending:  OFF')
    expect(r.stdout).toContain('replies:  OFF')
    expect(calls()[1]!.env.SMTP_HOST).toBeUndefined()
  })

  it('refuses the pooled endpoint, saved or not, before the worker is started', () => {
    const repo = layout()
    save('DATABASE_URL', DB.replace('ep-quiet-sky-123.', 'ep-quiet-sky-123-pooler.'))
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("POOLED endpoint")
    // The build runs before any answer is read (round 9, [9]), so it has
    // run — holding none of them — and the worker has not.
    const c = calls()
    expect(c.map((x) => x.argv)).toEqual(['tsc --build'])
    expect(c[0]!.env.DATABASE_URL).toBeUndefined()
    expect(r.stderr).not.toContain('db-password-never-in-argv-77')
  })

  it('asks for npm ci before anything when the checkout has no node_modules', () => {
    const repo = layout()
    rmSync(join(repo, 'node_modules'), { recursive: true })
    save('DATABASE_URL', DB)
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("npm ci")
    expect(calls()).toEqual([])
  })

  it.each(['tsc', 'tsx'])('asks for npm ci — and never reaches for npx — when the lockfile’s %s is missing', (tool) => {
    // An install with --omit=dev, or under NODE_ENV=production: node_modules
    // is there and the development tools are not. npx would fetch whatever
    // the registry holds under that name and run it with every credential
    // in its environment (round 9, [9]).
    const repo = layout()
    rmSync(join(repo, 'node_modules/.bin', tool))
    save('DATABASE_URL', DB)
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`no node_modules/.bin/${tool}`)
    expect(r.stderr).toContain("Run 'npm ci'")
    expect(calls()).toEqual([])
    expect(npxRan()).toBe(false)
    // Asked before anything was read: not even the Keychain.
    expect(existsSync(join(logs, 'security-argv'))).toBe(false)
  })

  it('keeps a saved UNSUBSCRIBE_SECRET, and with none saved sends without the header — making none', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    save('SMTP_HOST', 'smtp.resend.com')
    save('MAIL_FROM', FROM)
    save('UNSUBSCRIBE_SECRET', UNSUB)
    expect(run(repo).status).toBe(0)
    expect(calls()[1]!.env.UNSUBSCRIBE_SECRET).toBe(UNSUB)

    rmSync(join(keychain, 'UNSUBSCRIBE_SECRET'))
    rmSync(join(logs, 'run'))
    const r = run(repo)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('WITHOUT an unsubscribe header')
    expect(calls()[1]!.env.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(saved('UNSUBSCRIBE_SECRET')).toBeUndefined()
    expect(clipboard()).toBeUndefined()
  })

  describe('chat, through an ngrok tunnel', () => {
    const ngrokArgv = () => (existsSync(join(logs, 'ngrok-argv')) ? readFileSync(join(logs, 'ngrok-argv'), 'utf8') : undefined)
    const ngrokEnv = () => readFileSync(join(logs, 'ngrok-env'), 'utf8')
    const saveChat = () => {
      save('DATABASE_URL', DB)
      save('SMTP_PASSWORD', SMTP_PASSWORD)
      save('CHAT_URL', `https://${CHAT_DOMAIN}`)
      save('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
      save('AGENT_INTERNAL_TOKEN', CHAT_TOKEN)
    }
    const noChat = () => {
      const worker = calls()[1]!.env
      expect(worker.ANTHROPIC_API_KEY).toBeUndefined()
      expect(worker.AGENT_INTERNAL_TOKEN).not.toBe(CHAT_TOKEN)
      expect(worker.AGENT_INTERNAL_TOKEN?.length).toBeGreaterThanOrEqual(32)
    }

    /**
     * `--ai` (2026-10-07): a model sorts replies and polishes openers. It runs
     * on the Anthropic key, which only a chat-on run hands the worker, so the
     * saved choice reaches the worker with chat and is withheld without it.
     */
    const saveAi = () => {
      save('LLM_PROVIDER', 'anthropic')
      save('LLM_MODEL', 'claude-haiku-4-5')
      save('LLM_ALLOW_REMOTE_LEAD_DATA', 'true')
    }

    it('hands a saved model choice to the worker with chat on, and says so', () => {
      ngrokStub()
      saveChat()
      saveAi()
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('ai:       ON  — a model sorts replies and polishes openers (claude-haiku-4-5)')
      const worker = calls()[1]!.env
      expect(worker.LLM_PROVIDER).toBe('anthropic')
      expect(worker.LLM_MODEL).toBe('claude-haiku-4-5')
      expect(worker.LLM_ALLOW_REMOTE_LEAD_DATA).toBe('true')
      expect(worker.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
    })

    it('withholds the model choice without chat, which hands the worker no key, and says why', () => {
      save('DATABASE_URL', DB)
      saveAi()
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('ai:       OFF — it uses the Anthropic key, which only a run with chat on hands the worker')
      const worker = calls()[1]!.env
      expect(worker.LLM_PROVIDER).toBeUndefined()
      expect(worker.LLM_ALLOW_REMOTE_LEAD_DATA).toBeUndefined()
      expect(worker.ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('names --ai when no model is chosen', () => {
      save('DATABASE_URL', DB)
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('ai:       OFF — replies are read by keyword and openers keep the template')
      expect(r.stdout).toContain('--ai')
    })

    it('runs the tunnel and hands the worker the key and the saved token — none of them on any argv, nothing to ngrok', () => {
      ngrokStub()
      saveChat()
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain(`chat:     ON  — the live site reaches this Mac at https://${CHAT_DOMAIN}`)
      const worker = calls()[1]!.env
      expect(worker.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
      expect(worker.AGENT_INTERNAL_TOKEN).toBe(CHAT_TOKEN)
      expect(worker.AGENT_MODEL).toBe('claude-haiku-4-5')
      expect(worker.AGENT_BIND).toBe('127.0.0.1')
      // The API port, on the domain, with the request inspector OFF: on, it
      // keeps every forwarded request — the bearer included — on an
      // unauthenticated local page (review round 15).
      expect(ngrokArgv()).toBe(
        `http 127.0.0.1:${API_PORT} --url=https://${CHAT_DOMAIN} --inspect=false --log=stdout --log-format=logfmt --log-level=info\n`,
      )
      // ngrok's environment holds no credential this script was handed.
      const env = ngrokEnv()
      for (const secret of [DB, SMTP_PASSWORD, ANTHROPIC_KEY, CHAT_TOKEN]) expect(env).not.toContain(secret)
      for (const name of CREDENTIALS) expect(env, name).not.toMatch(new RegExp(`^${name}=`, 'm'))
      // No secret on an argv or the screen.
      const argvs = [...calls().map((x) => x.argv), ngrokArgv()!, readFileSync(join(logs, 'security-argv'), 'utf8')].join('\n')
      for (const secret of [ANTHROPIC_KEY, CHAT_TOKEN]) {
        expect(argvs).not.toContain(secret)
        expect(r.stdout + r.stderr).not.toContain(secret)
      }
    })

    /**
     * The worker here exits at once, as one that refuses to boot does, and
     * the exec leaves nothing in the script to stop ngrok: the watcher does,
     * or the tunnel held the domain out of reach of Ctrl-C (review round 15).
     */
    it('stops ngrok when the worker exits', () => {
      ngrokStub()
      saveChat()
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(goneWithin(ngrokPid(), 6_000)).toBe(true)
    })

    // The script appends Homebrew's two prefixes to PATH, so where ngrok is
    // installed there — the operator's own Mac — it cannot be made to look
    // absent, and the run would start the real binary.
    const ngrokInstalled = ['/usr/local/bin/ngrok', '/opt/homebrew/bin/ngrok'].some((p) => existsSync(p))
    it.skipIf(ngrokInstalled)('leaves chat off, says why, and hands the worker no key when ngrok is not installed', () => {
      saveChat()
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain("chat:     OFF — ngrok is not installed: 'brew install ngrok'")
      noChat()
    })

    it('leaves chat off, and says so, when ngrok cannot open the domain', () => {
      stub('ngrok', 'echo "ERR_NGROK_4018: authentication failed"; exit 1')
      saveChat()
      const r = run(layout())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).toContain('ERR_NGROK_4018')
      expect(r.stdout).toContain(`chat:     OFF — ngrok could not open ${CHAT_DOMAIN}`)
      noChat()
    })

    /**
     * ngrok that cannot reach or sign in to its edge does not exit — it
     * retries for ever — so "still running after three seconds" said ON and
     * handed the worker the key while nothing was served (review round 15).
     */
    it('leaves chat off, and stops ngrok, when it stays up without ever opening the tunnel', () => {
      ngrokStub('t=2026-10-06T00:00:00+0000 lvl=eror msg="failed to reconnect session" obj=tunnels.session err="no route"')
      saveChat()
      const r = run(layout(), [], { AGENCY_TUNNEL_WAIT_SECONDS: '2' })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stderr).toContain('failed to reconnect session')
      expect(r.stdout).toContain(`chat:     OFF — ngrok could not open ${CHAT_DOMAIN}`)
      noChat()
      expect(goneWithin(ngrokPid(), 3_000)).toBe(true)
    })

    it('does not take a tunnel on another domain for this one', () => {
      ngrokStub('t=2026-10-06T00:00:00+0000 lvl=info msg="started tunnel" obj=tunnels url=https://someone-else.ngrok-free.app')
      saveChat()
      const r = run(layout(), [], { AGENCY_TUNNEL_WAIT_SECONDS: '2' })
      expect(r.stdout).toContain(`chat:     OFF — ngrok could not open ${CHAT_DOMAIN}`)
      noChat()
    })

    it('hands the worker no key when chat was never turned on, whatever is saved', () => {
      ngrokStub()
      save('DATABASE_URL', DB)
      save('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
      const r = run(layout())
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('chat:     OFF — no inbound route')
      expect(calls()[1]!.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(ngrokArgv()).toBeUndefined()
    })

    /** With chat off it would publish a port whose token nobody holds (review round 15). */
    it('stops a tunnel an earlier run left on the worker’s port', async () => {
      save('DATABASE_URL', DB)
      const left = spawn('bash', ['-c', `exec -a "ngrok http 127.0.0.1:${API_PORT} --url=https://old.ngrok-free.app" sleep 30`], {
        stdio: 'ignore',
        detached: true,
      })
      // A shell whose command line merely MENTIONS the tunnel: the first
      // version's unanchored pattern killed exactly this — the shell running
      // the test suite.
      const bystander = spawn('bash', ['-c', `sleep 30; : ngrok http 127.0.0.1:${API_PORT} --url=x`], { stdio: 'ignore', detached: true })
      try {
        spawnSync('sleep', ['0.3'])
        const r = run(layout())
        expect(r.status, r.stderr).toBe(0)
        expect(r.stdout).toContain("Stopped an ngrok tunnel an earlier run left on this worker's port.")
        // Its own child: polled with kill(0) it would read as alive until
        // this process reaps it, so its exit is awaited instead.
        expect(await exitedWithin(left, 3_000)).toBe(true)
        expect(bystander.exitCode === null && bystander.signalCode === null).toBe(true)
      } finally {
        for (const p of [left.pid!, bystander.pid!]) {
          try {
            process.kill(p)
          } catch {
            // already gone
          }
        }
      }
    })

    /**
     * The harness's own guard: a tunnel on the DEFAULT port — the live
     * worker's, when this file runs on the machine that worker runs on —
     * outlives every run here.
     */
    it('leaves a tunnel on the default port alone — the live one, on the operator’s machine', async () => {
      save('DATABASE_URL', DB)
      const live = spawn('bash', ['-c', 'exec -a "ngrok http 127.0.0.1:3002 --url=https://live.ngrok-free.app" sleep 30'], {
        stdio: 'ignore',
        detached: true,
      })
      try {
        spawnSync('sleep', ['0.3'])
        const r = run(layout())
        expect(r.status, r.stderr).toBe(0)
        expect(r.stdout).not.toContain('Stopped an ngrok tunnel')
        expect(await exitedWithin(live, 500)).toBe(false)
      } finally {
        try {
          process.kill(live.pid!)
        } catch {
          // already gone
        }
      }
    })

    /**
     * What happened on the operator's Mac: `--imap` typed in a second window
     * while the worker ran stopped that worker's tunnel, then died on the
     * ports it held — chat on the site down, the worker still up. Either
     * port answering stops a run before it builds, asks or touches a tunnel.
     */
    it.each([
      ['health', AGENT_PORT],
      ['API', API_PORT],
    ])('refuses to run beside a worker already on its %s port, stopping no tunnel', async (_which, port) => {
      save('DATABASE_URL', DB)
      const busy = createServer().listen(Number(port), '127.0.0.1')
      await once(busy, 'listening')
      const live = spawn('bash', ['-c', `exec -a "ngrok http 127.0.0.1:${API_PORT} --url=https://live.ngrok-free.app" sleep 30`], {
        stdio: 'ignore',
        detached: true,
      })
      try {
        spawnSync('sleep', ['0.3'])
        const r = run(layout(), ['--imap'])
        expect(r.status, r.stderr).toBe(1)
        expect(r.stderr).toContain(`Port ${port} on this machine is already in use`)
        expect(r.stdout).not.toContain('Stopped an ngrok tunnel')
        expect(calls()).toEqual([])
        expect(await exitedWithin(live, 500)).toBe(false)
        expect(saved('DATABASE_URL')).toBe(DB)
      } finally {
        try {
          process.kill(live.pid!)
        } catch {
          // already gone
        }
        busy.close()
      }
    })

    it('lets --forget run beside a worker: it changes only the Keychain', async () => {
      save('DATABASE_URL', DB)
      const busy = createServer().listen(Number(AGENT_PORT), '127.0.0.1')
      await once(busy, 'listening')
      try {
        const r = run(layout(), ['--forget'])
        expect(r.status, r.stderr).toBe(0)
        expect(readdirSync(keychain)).toEqual([])
      } finally {
        busy.close()
      }
    })

    /**
     * A key or token exported in the calling shell was used when Enter was
     * pressed, and saved under this service: every teammate's turn billed to
     * a key nobody chose here (review round 15). Only a saved or typed value
     * counts.
     */
    it('ignores a key or token exported in the shell', () => {
      save('DATABASE_URL', DB)
      save('CHAT_URL', `https://${CHAT_DOMAIN}`)
      save('AGENT_INTERNAL_TOKEN', CHAT_TOKEN)
      ngrokStub()
      const r = run(layout(), [], { ANTHROPIC_API_KEY: 'sk-ant-AMBIENT-shell-key', AGENT_INTERNAL_TOKEN: 'a'.repeat(64) })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('chat:     OFF — no Anthropic API key was given')
      const [build, worker] = calls()
      expect(build!.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(build!.env.AGENT_INTERNAL_TOKEN).toBeUndefined()
      expect(worker!.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(worker!.env.AGENT_INTERNAL_TOKEN).not.toBe('a'.repeat(64))
      expect(saved('ANTHROPIC_API_KEY')).toBeUndefined()
    })
  })

  it('forgets every saved answer with --forget', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    const r = run(repo, ['--forget'])
    expect(r.status).toBe(0)
    expect(readdirSync(keychain)).toEqual([])
    expect(calls()).toEqual([])
  })

  /**
   * The web app encrypts a connector's key with SECRETS_KEY and the worker
   * decrypts it, so the worker needs the same value; the script never passed
   * one, and every keyed connector was skipped on the laptop worker.
   */
  it('hands a saved SECRETS_KEY to the worker, on no argument list and not on the screen', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    save('SECRETS_KEY', SECRETS_KEY)
    const r = run(repo)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('keys:     ON')
    const c = calls()
    expect(c[0]!.env.SECRETS_KEY).toBeUndefined()
    expect(c[1]!.env.SECRETS_KEY).toBe(SECRETS_KEY)
    const argvs = [...c.map((x) => x.argv), readFileSync(join(logs, 'security-argv'), 'utf8')].join('\n')
    expect(argvs).not.toContain(SECRETS_KEY)
    expect(r.stdout + r.stderr).not.toContain(SECRETS_KEY)
  })

  it('says only keyless connectors work without a SECRETS_KEY, and names the option that takes one', () => {
    save('DATABASE_URL', DB)
    const r = run(layout())
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('keys:     OFF')
    expect(r.stdout).toContain('--secrets-key')
    expect(calls()[1]!.env.SECRETS_KEY).toBeUndefined()
  })

  it('refuses an argument it does not know', () => {
    const r = run(layout(), ['--save-everything'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage')
    expect(r.stderr).toContain('--imap')
  })

  // setsid (util-linux) starts the script in a session of its own, with no
  // controlling terminal, so /dev/tty cannot open; a run started anywhere
  // else would open the terminal vitest itself runs in, and wait at it.
  it.runIf(spawnSync('setsid', ['--wait', 'true']).status === 0)(
    '--imap without a terminal asks nothing, starts no worker and changes nothing saved',
    () => {
      const repo = layout()
      save('DATABASE_URL', DB)
      save('IMAP_HOST', 'imap.gmail.com')
      save('IMAP_USER', 'ryan@myagencyos.in')
      save('IMAP_PASSWORD', IMAP_PASSWORD)
      const r = spawnSync('setsid', ['--wait', 'bash', join(repo, 'tools/run-worker.sh'), '--imap'], {
        cwd: repo,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, KEYCHAIN: keychain, LOGS: logs, AGENT_PORT },
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(r.status, r.stderr).toBe(1)
      expect(r.stderr).toContain('This script needs a terminal')
      expect(calls().map((x) => x.argv)).toEqual(['tsc --build'])
      expect(saved('IMAP_PASSWORD')).toBe(IMAP_PASSWORD)
      expect(saved('DATABASE_URL')).toBe(DB)
    },
  )
})

// ---------------------------------------------------------------------------
// The questions, answered through a terminal (review round 9, [2] and [7])
// ---------------------------------------------------------------------------

/**
 * util-linux's `script`, which runs a command on a pseudo-terminal of its
 * own: the run-worker prompts open /dev/tty, and this is one. `--echo never`
 * so nothing typed is echoed into the transcript, whatever the moment a
 * hidden prompt turns echo off. macOS's `script` takes other arguments; there
 * only the saved-answer path above runs.
 */
const PTY = (() => {
  const v = spawnSync('script', ['--version'], { encoding: 'utf8' })
  const help = spawnSync('script', ['--help'], { encoding: 'utf8' })
  return v.status === 0 && /util-linux/.test(v.stdout) && /--echo/.test(help.stdout)
})()

/** One answer, typed when the prompt containing `prompt` has appeared. */
type Turn = readonly [prompt: string, answer: string]

/**
 * Run the script on a terminal, answering each prompt in order as it
 * appears, and wait for it to finish. A prompt that never comes ends the run
 * at the timeout with what was printed, so a failure says where it stuck.
 */
function converse(repo: string, args: string[], turns: readonly Turn[]): Promise<{ status: number | null; transcript: string; unanswered: string[] }> {
  const command = ['bash', join(repo, 'tools/run-worker.sh'), ...args].map((a) => `'${a}'`).join(' ')
  const child = spawn('script', ['-q', '-f', '-e', '--echo', 'never', '-c', command, '/dev/null'], {
    cwd: repo,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, KEYCHAIN: keychain, LOGS: logs, AGENT_PORT, SHELL: '/bin/sh', TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let transcript = ''
  let next = 0
  let from = 0
  const answer = () => {
    while (next < turns.length) {
      const [prompt, reply] = turns[next]!
      const at = transcript.indexOf(prompt, from)
      if (at < 0) return
      from = at + prompt.length
      child.stdin.write(`${reply}\n`)
      next++
    }
  }
  child.stdout.on('data', (d: Buffer) => {
    transcript += d.toString('utf8')
    answer()
  })
  child.stderr.on('data', (d: Buffer) => {
    transcript += d.toString('utf8')
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      child.stdin.destroy()
      resolve({ status, transcript, unanswered: turns.slice(next).map(([p]) => p) })
    })
  })
}

interface Dialog {
  /** Configure sending (the unsubscribe question is asked only then). */
  readonly smtp: boolean
  /** Turn chat on: the domain, then the key typed at its prompt ('' keeps a saved one). */
  readonly chat?: {
    readonly domain: string
    readonly key: string
    readonly pasteFirst?: boolean
    readonly saved?: boolean
    /** Typed at the saved token's prompt: '' keeps it, `copy` or `new`. */
    readonly token?: '' | 'copy' | 'new'
  }
  /** The IMAP hosts and usernames typed, in order, when reply detection is configured. */
  readonly imap?: { readonly hosts: readonly string[]; readonly users: readonly string[] }
  /** Typed at the unsubscribe prompt: '' is Enter. */
  readonly unsubscribe?: string
  /** Typed at "Make a new UNSUBSCRIBE_SECRET?", when the script asks it. */
  readonly confirmNew?: string
  /** Typed at "Remember these answers", which only a Mac is asked. */
  readonly remember?: string
}

/** Every prompt the script asks, in order, with these answers. */
function dialog(d: Dialog): Turn[] {
  const t: Turn[] = [['Production DATABASE_URL', DB], ['Configure SENDING email now?', d.smtp ? 'y' : 'n']]
  if (d.smtp) {
    t.push(['SMTP host', ''], ['SMTP port', ''], ['SMTP username', ''], ['SMTP password', SMTP_PASSWORD], ['From address', FROM])
  }
  t.push(['Configure SMS through DoveSoft now?', 'n'], ['Configure REPLY DETECTION now?', d.imap ? 'y' : 'n'])
  if (d.imap) {
    for (const h of d.imap.hosts) t.push(['IMAP host', h])
    for (const u of d.imap.users) t.push(['IMAP username', u])
    t.push(['IMAP password', IMAP_PASSWORD])
  }
  t.push(['Public address of the web app', ''])
  if (d.smtp) t.push(['One-click unsubscribe', d.unsubscribe ?? ''])
  if (d.confirmNew !== undefined) t.push(['Make a new UNSUBSCRIBE_SECRET?', d.confirmNew])
  t.push(['Slack webhook URL', ''])
  t.push(['Turn on CHAT on the live site', d.chat ? 'y' : 'n'])
  if (d.chat) {
    t.push(['Your ngrok static domain', d.chat.domain], ['Anthropic API key', d.chat.key])
    if (d.chat.saved) t.push(['AGENT_INTERNAL_TOKEN: Enter keeps', d.chat.token ?? ''])
    if (d.chat.pasteFirst) t.push(['Paste it into Vercel first', ''])
    if (!d.chat.saved || (d.chat.token ?? '') !== '') t.push(['Press Enter once both are saved', ''])
  }
  if (d.remember !== undefined) t.push(['Remember these answers', d.remember])
  return t
}

describe.runIf(PTY)('tools/run-worker.sh, answered at its prompts', () => {
  /** Run, and expect it to finish with every prompt answered and no secret on the screen. */
  async function answered(repo: string, args: string[], d: Dialog) {
    const r = await converse(repo, args, dialog(d))
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    for (const secret of ['db-password-never-in-argv-77', SMTP_PASSWORD, UNSUB, VERCEL_UNSUB]) expect(r.transcript).not.toContain(secret)
    const c = calls()
    expect(c.map((x) => x.argv)).toEqual(['tsc --build', 'tsx apps/agent/src/index.ts'])
    // Built before the first question: the build holds no answer.
    for (const name of CREDENTIALS) expect(c[0]!.env[name], name).toBeUndefined()
    expect(c[1]!.env.DATABASE_URL).toBe(DB)
    expect(npxRan()).toBe(false)
    return { transcript: r.transcript, worker: c[1]!.env }
  }

  it('on a Mac, with nothing saved: Enter sends WITHOUT an unsubscribe header and makes no secret', async () => {
    const r = await answered(layout(), [], { smtp: true, unsubscribe: '', remember: 'y' })
    expect(r.worker.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(r.transcript).toContain('WITHOUT an unsubscribe header')
    expect(r.transcript).not.toContain('with a one-click unsubscribe link')
    expect(clipboard()).toBeUndefined()
    expect(saved('UNSUBSCRIBE_SECRET')).toBeUndefined()
    // The rest was remembered.
    expect(saved('DATABASE_URL')).toBe(DB)
    expect(saved('SMTP_PASSWORD')).toBe(SMTP_PASSWORD)
  })

  it('on a Mac, --reconfigure: Enter KEEPS the saved secret — it is the default, never a rotation', async () => {
    save('DATABASE_URL', DB)
    save('UNSUBSCRIBE_SECRET', UNSUB)
    const r = await answered(layout(), ['--reconfigure'], { smtp: true, unsubscribe: '', remember: 'y' })
    expect(r.transcript).toContain('Enter keeps the one saved in your Keychain')
    expect(r.worker.UNSUBSCRIBE_SECRET).toBe(UNSUB)
    expect(r.transcript).toContain('with a one-click unsubscribe link to https://myagencyos.in')
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(UNSUB)
    expect(clipboard()).toBeUndefined()
  })

  it('on a Mac, --reconfigure with sending turned off: the saved secret survives being remembered', async () => {
    save('DATABASE_URL', DB)
    save('SMTP_HOST', 'smtp.resend.com')
    save('MAIL_FROM', FROM)
    save('UNSUBSCRIBE_SECRET', UNSUB)
    const r = await answered(layout(), ['--reconfigure'], { smtp: false, remember: 'y' })
    expect(r.transcript).toContain('sending:  OFF')
    expect(saved('SMTP_HOST')).toBeUndefined()
    // The one value Vercel can never show back is still here for the run that turns sending on again.
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(UNSUB)
  })

  it('a pasted value is used as given — and declining to remember says the saved, different one is what the next run reads', async () => {
    save('DATABASE_URL', DB)
    save('UNSUBSCRIBE_SECRET', UNSUB)
    const r = await answered(layout(), ['--reconfigure'], { smtp: true, unsubscribe: VERCEL_UNSUB, remember: 'n' })
    expect(r.worker.UNSUBSCRIBE_SECRET).toBe(VERCEL_UNSUB)
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(UNSUB)
    expect(r.transcript).toContain('the next run without')
    expect(r.transcript).toContain('different UNSUBSCRIBE_SECRET')
  })

  it('on a Mac, `new` and a yes: one secret, on the clipboard, saved at once — even when the answers are not remembered', async () => {
    const r = await answered(layout(), [], { smtp: true, unsubscribe: 'new', confirmNew: 'y', remember: 'n' })
    const made = r.worker.UNSUBSCRIBE_SECRET
    expect(made).toMatch(/^[0-9a-f]{64}$/)
    expect(clipboard()).toBe(made)
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(made)
    // Declined: nothing else was kept…
    expect(saved('DATABASE_URL')).toBeUndefined()
    // …and the warning came before the yes, not after.
    const warned = r.transcript.indexOf('every unsubscribe link already mailed')
    expect(warned).toBeGreaterThan(-1)
    expect(warned).toBeLessThan(r.transcript.indexOf('Make a new UNSUBSCRIBE_SECRET?'))
    expect(r.transcript).toContain('Paste it into Vercel')
    expect(r.transcript).not.toContain(made!)
  })

  it('on a Mac, `new` that the Keychain will not keep: nothing is made, and the clipboard is cleared', async () => {
    // `security -i` answering 0 for a command it refused: the write is read back, not trusted.
    writeFileSync(join(bin, 'security'), readFileSync(join(bin, 'security'), 'utf8').replace('printf "%s" "$w" > "$KEYCHAIN/$a"', ':'))
    const r = await answered(layout(), [], { smtp: true, unsubscribe: 'new', confirmNew: 'y', remember: 'n' })
    expect(r.transcript).toContain('Could not save a new secret in your Keychain, so none was made')
    expect(r.transcript).toContain('WITHOUT an unsubscribe header')
    expect(r.worker.UNSUBSCRIBE_SECRET).toBeUndefined()
    expect(clipboard()).toBe('')
  })

  it('on a Mac, `new` and a no: nothing is made, and the saved secret is kept', async () => {
    save('DATABASE_URL', DB)
    save('UNSUBSCRIBE_SECRET', UNSUB)
    const r = await answered(layout(), ['--reconfigure'], { smtp: true, unsubscribe: 'new', confirmNew: 'n', remember: 'y' })
    expect(r.worker.UNSUBSCRIBE_SECRET).toBe(UNSUB)
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(UNSUB)
    expect(clipboard()).toBeUndefined()
  })

  it('on a Mac, chat yes: one token, on the clipboard and saved, the key in the Keychain — and the worker runs with both', async () => {
    ngrokStub()
    const r = await answered(layout(), [], { smtp: false, chat: { domain: `https://${CHAT_DOMAIN}/`, key: ANTHROPIC_KEY }, remember: 'y' })
    const token = r.worker.AGENT_INTERNAL_TOKEN
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(clipboard()).toBe(token)
    expect(saved('AGENT_INTERNAL_TOKEN')).toBe(token)
    expect(saved('ANTHROPIC_API_KEY')).toBe(ANTHROPIC_KEY)
    expect(saved('CHAT_URL')).toBe(`https://${CHAT_DOMAIN}`)
    expect(r.worker.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
    expect(r.transcript).toContain(`AGENT_URL            = https://${CHAT_DOMAIN}`)
    for (const secret of [token!, ANTHROPIC_KEY]) expect(r.transcript).not.toContain(secret)
  })

  it('on a Mac, a new unsubscribe secret is not overwritten on the clipboard before it is pasted', async () => {
    ngrokStub()
    const r = await answered(layout(), [], {
      smtp: true, unsubscribe: 'new', confirmNew: 'y',
      chat: { domain: CHAT_DOMAIN, key: ANTHROPIC_KEY, pasteFirst: true }, remember: 'y',
    })
    const waited = r.transcript.indexOf('The new UNSUBSCRIBE_SECRET is still on your clipboard')
    expect(waited).toBeGreaterThan(-1)
    expect(waited).toBeLessThan(r.transcript.indexOf('A new AGENT_INTERNAL_TOKEN is on your clipboard'))
    expect(clipboard()).toBe(r.worker.AGENT_INTERNAL_TOKEN)
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(r.worker.UNSUBSCRIBE_SECRET)
  })

  it('on a Mac, --reconfigure with chat on: Enter keeps the saved key and token — never a rotation', async () => {
    ngrokStub()
    save('DATABASE_URL', DB)
    save('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
    save('AGENT_INTERNAL_TOKEN', CHAT_TOKEN)
    const r = await answered(layout(), ['--reconfigure'], { smtp: false, chat: { domain: CHAT_DOMAIN, key: '', saved: true }, remember: 'y' })
    expect(r.worker.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY)
    expect(r.worker.AGENT_INTERNAL_TOKEN).toBe(CHAT_TOKEN)
    expect(r.transcript).toContain('Kept. Vercel must hold the same token')
    // Vercel's AGENT_URL is named all the same: a saved token may have been
    // set beside another address.
    expect(r.transcript).toContain(`and AGENT_URL = https://${CHAT_DOMAIN} (Production)`)
    expect(clipboard()).toBeUndefined()
  })

  /**
   * Vercel keeps the token Sensitive and never shows it back, so the
   * Keychain's copy is the only one a person can put back in step (review
   * round 15): `copy` puts the SAVED token on the clipboard, unchanged.
   */
  it('on a Mac, --reconfigure with chat on: copy puts the saved token on the clipboard again — no rotation', async () => {
    ngrokStub()
    save('DATABASE_URL', DB)
    save('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
    save('AGENT_INTERNAL_TOKEN', CHAT_TOKEN)
    const r = await answered(layout(), ['--reconfigure'], { smtp: false, chat: { domain: CHAT_DOMAIN, key: '', saved: true, token: 'copy' }, remember: 'y' })
    expect(clipboard()).toBe(CHAT_TOKEN)
    expect(saved('AGENT_INTERNAL_TOKEN')).toBe(CHAT_TOKEN)
    expect(r.worker.AGENT_INTERNAL_TOKEN).toBe(CHAT_TOKEN)
    expect(r.transcript).toContain(`AGENT_URL            = https://${CHAT_DOMAIN}`)
    expect(r.transcript).not.toContain(CHAT_TOKEN)
  })

  it('on a Mac, --reconfigure with chat on: new replaces the saved token, on the clipboard and in the Keychain', async () => {
    ngrokStub()
    save('DATABASE_URL', DB)
    save('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
    save('AGENT_INTERNAL_TOKEN', CHAT_TOKEN)
    const r = await answered(layout(), ['--reconfigure'], { smtp: false, chat: { domain: CHAT_DOMAIN, key: '', saved: true, token: 'new' }, remember: 'y' })
    const token = r.worker.AGENT_INTERNAL_TOKEN
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(token).not.toBe(CHAT_TOKEN)
    expect(clipboard()).toBe(token)
    expect(saved('AGENT_INTERNAL_TOKEN')).toBe(token)
  })

  it('on a Mac, --reconfigure with chat turned off: the saved key and token survive being remembered, and the worker gets neither', async () => {
    save('DATABASE_URL', DB)
    save('CHAT_URL', `https://${CHAT_DOMAIN}`)
    save('ANTHROPIC_API_KEY', ANTHROPIC_KEY)
    save('AGENT_INTERNAL_TOKEN', CHAT_TOKEN)
    const r = await answered(layout(), ['--reconfigure'], { smtp: false, remember: 'y' })
    expect(saved('ANTHROPIC_API_KEY')).toBe(ANTHROPIC_KEY)
    expect(saved('AGENT_INTERNAL_TOKEN')).toBe(CHAT_TOKEN)
    expect(saved('CHAT_URL')).toBeUndefined()
    expect(r.worker.ANTHROPIC_API_KEY).toBeUndefined()
    expect(r.worker.AGENT_INTERNAL_TOKEN).not.toBe(CHAT_TOKEN)
    expect(r.transcript).toContain('chat:     OFF — no inbound route')
  })

  it('asks the IMAP host until it is a server name, and Google\'s username until it is a whole address', async () => {
    const r = await answered(layout(), [], {
      smtp: false,
      imap: { hosts: ['ryan@myagencyos.in', ''], users: ['ryan', 'ryan@myagencyos.in'] }, remember: 'y',
    })
    expect(r.transcript).toContain('That is not a server name (it should look like imap.gmail.com)')
    expect(r.transcript).toContain('Google needs the whole address')
    expect(r.worker.IMAP_HOST).toBe('imap.gmail.com')
    expect(r.worker.IMAP_USER).toBe('ryan@myagencyos.in')
    expect(r.worker.IMAP_PASSWORD).toBe(IMAP_PASSWORD)
    expect(r.transcript).not.toContain(IMAP_PASSWORD)
  })

  /**
   * The reason --imap exists: Google refused the saved app password, and
   * the only way to type a new one was --reconfigure — the database string,
   * the SMTP key and every other answer again.
   */
  it('--imap asks reply detection alone over the saved answers, and saves the new app password without its spaces', async () => {
    save('DATABASE_URL', DB)
    save('SMTP_HOST', 'smtp.resend.com')
    save('SMTP_PORT', '465')
    save('SMTP_USER', 'resend')
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    save('MAIL_FROM', FROM)
    save('IMAP_HOST', 'imap.gmail.com')
    save('IMAP_USER', 'ryan@myagencyos.in')
    save('IMAP_PASSWORD', 'the-old-refused-one')
    save('WEB_PUBLIC_URL', 'https://myagencyos.in')
    save('UNSUBSCRIBE_SECRET', UNSUB)
    const r = await converse(layout(), ['--imap'], [
      ['IMAP host [imap.gmail.com]', ''],
      ['IMAP username [ryan@myagencyos.in]', ''],
      ['Enter keeps the saved one', 'abcd efgh ijkl mnop'],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('Reply detection only')
    expect(r.transcript).not.toContain('Production DATABASE_URL')
    expect(r.transcript).not.toContain('Configure SENDING')
    expect(r.transcript).not.toContain('Remember these answers')
    expect(r.transcript).toContain('replies:  ON')
    for (const secret of ['abcd efgh', 'abcdefghijklmnop', 'db-password-never-in-argv-77', SMTP_PASSWORD, UNSUB]) {
      expect(r.transcript).not.toContain(secret)
    }

    const c = calls()
    expect(c.map((x) => x.argv)).toEqual(['tsc --build', 'tsx apps/agent/src/index.ts'])
    const worker = c[1]!.env
    expect(worker.IMAP_PASSWORD).toBe('abcdefghijklmnop')
    expect(worker.IMAP_USER).toBe('ryan@myagencyos.in')
    expect(worker.DATABASE_URL).toBe(DB)
    expect(worker.SMTP_PASSWORD).toBe(SMTP_PASSWORD)
    expect(worker.UNSUBSCRIBE_SECRET).toBe(UNSUB)

    expect(saved('IMAP_PASSWORD')).toBe('abcdefghijklmnop')
    expect(saved('IMAP_USER')).toBe('ryan@myagencyos.in')
    expect(saved('DATABASE_URL')).toBe(DB)
    expect(saved('SMTP_PASSWORD')).toBe(SMTP_PASSWORD)
    expect(saved('UNSUBSCRIBE_SECRET')).toBe(UNSUB)
    expect(readFileSync(join(logs, 'security-argv'), 'utf8')).not.toContain('abcdefghijklmnop')
  })

  it('--imap with nothing saved asks every question, as a first run does', async () => {
    const r = await answered(layout(), ['--imap'], {
      smtp: false,
      imap: { hosts: [''], users: ['ryan@myagencyos.in'] }, remember: 'y',
    })
    expect(r.transcript).not.toContain('Reply detection only')
    expect(r.worker.IMAP_PASSWORD).toBe(IMAP_PASSWORD)
    expect(saved('IMAP_PASSWORD')).toBe(IMAP_PASSWORD)
    expect(saved('DATABASE_URL')).toBe(DB)
  })

  it('--secrets-key asks for the key alone, refuses one that is not 32 bytes, and saves it', async () => {
    save('DATABASE_URL', DB)
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    const r = await converse(layout(), ['--secrets-key'], [
      ['SECRETS_KEY — paste the value Vercel holds', Buffer.alloc(16, 7).toString('base64')],
      ['SECRETS_KEY — paste the value Vercel holds', SECRETS_KEY],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('That is not a key: it must be base64 of 32 bytes')
    expect(r.transcript).toContain('Saved in your Keychain; the next run uses it too.')
    expect(r.transcript).toContain('keys:     ON')
    expect(r.transcript).not.toContain('Production DATABASE_URL')
    expect(r.transcript).not.toContain(SECRETS_KEY)
    const c = calls()
    expect(c.map((x) => x.argv)).toEqual(['tsc --build', 'tsx apps/agent/src/index.ts'])
    expect(c[1]!.env.SECRETS_KEY).toBe(SECRETS_KEY)
    expect(c[1]!.env.SMTP_PASSWORD).toBe(SMTP_PASSWORD)
    expect(saved('SECRETS_KEY')).toBe(SECRETS_KEY)
    expect(saved('SMTP_PASSWORD')).toBe(SMTP_PASSWORD)
    expect(readFileSync(join(logs, 'security-argv'), 'utf8')).not.toContain(SECRETS_KEY)
  })

  it('--ai asks one question, and a yes saves the model choice', async () => {
    save('DATABASE_URL', DB)
    const r = await converse(layout(), ['--ai'], [['Let a model sort replies and polish openers?', 'y']])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('Saved; the next run uses it too.')
    expect(r.transcript).not.toContain('Production DATABASE_URL')
    expect(saved('LLM_PROVIDER')).toBe('anthropic')
    expect(saved('LLM_MODEL')).toBe('claude-haiku-4-5')
    expect(saved('LLM_ALLOW_REMOTE_LEAD_DATA')).toBe('true')
    // No chat here, so no key: the choice is kept and the worker told nothing.
    expect(r.transcript).toContain('ai:       OFF — it uses the Anthropic key')
    expect(calls()[1]!.env.LLM_PROVIDER).toBeUndefined()
  })

  it('--slack asks only for the webhook, refuses another host, and saves it', async () => {
    save('DATABASE_URL', DB)
    const HOOK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop'
    const r = await converse(layout(), ['--slack'], [
      ['Slack webhook URL', 'https://example.com/hook'],
      ['Slack webhook URL', HOOK],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('That is not a Slack incoming webhook')
    expect(r.transcript).toContain('Saved in your Keychain; the next run uses it too.')
    expect(r.transcript).toContain('alarm:    ON')
    expect(r.transcript).not.toContain('Production DATABASE_URL')
    expect(r.transcript).not.toContain(HOOK)
    expect(saved('SLACK_WEBHOOK_URL')).toBe(HOOK)
    expect(calls()[1]!.env.SLACK_WEBHOOK_URL).toBe(HOOK)
    expect(readFileSync(join(logs, 'security-argv'), 'utf8')).not.toContain(HOOK)
  })

  it('--google asks only for the key, refuses another shape, saves it, and keeps it through --reconfigure', async () => {
    save('DATABASE_URL', DB)
    const KEY = 'AIzaSyTESTKEY-0123456789abcdefghijklmn'
    const r = await converse(layout(), ['--google'], [
      ['Google API key', 'not-a-key'],
      ['Google API key', KEY],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('That is not a Google API key')
    expect(r.transcript).toContain('google:   ON')
    expect(r.transcript).not.toContain(KEY)
    expect(saved('GOOGLE_API_KEY')).toBe(KEY)
    expect(calls()[1]!.env.GOOGLE_API_KEY).toBe(KEY)
    expect(readFileSync(join(logs, 'security-argv'), 'utf8')).not.toContain(KEY)
  })

  it('--smtp asks only the outgoing mailbox, offering Google and the reply mailbox, and saves it', async () => {
    save('DATABASE_URL', DB)
    save('IMAP_HOST', 'imap.gmail.com')
    save('IMAP_USER', 'ryan@myagencyos.in')
    save('SMTP_HOST', 'smtp.resend.com')
    save('SMTP_USER', 'resend')
    save('MAIL_FROM', 'Ryan <ryan@myagencyos.in>')
    const r = await converse(layout(), ['--smtp'], [
      ['SMTP host', 'smtp.gmail.com'],
      ['SMTP port', ''],
      ['SMTP username [ryan@myagencyos.in]', ''],
      ['SMTP password', 'abcd efgh ijkl mnop'],
      ['From address', ''],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).not.toContain('Production DATABASE_URL')
    expect(saved('SMTP_HOST')).toBe('smtp.gmail.com')
    expect(saved('SMTP_USER')).toBe('ryan@myagencyos.in')
    expect(saved('SMTP_PASSWORD')).toBe('abcdefghijklmnop')
    expect(saved('MAIL_FROM')).toBe('Ryan <ryan@myagencyos.in>')
    expect(r.transcript).toContain('sending:  ON  — approved outreach goes via smtp.gmail.com')
    expect(readFileSync(join(logs, 'security-argv'), 'utf8')).not.toContain('abcdefghijklmnop')
  })

  it('--smtp will not keep a password saved for another server', async () => {
    save('DATABASE_URL', DB)
    save('IMAP_HOST', 'imap.gmail.com')
    save('IMAP_USER', 'ryan@myagencyos.in')
    save('SMTP_HOST', 'smtp.resend.com')
    save('SMTP_USER', 'resend')
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    save('MAIL_FROM', 'Ryan <ryan@myagencyos.in>')
    const r = await converse(layout(), ['--smtp'], [
      ['SMTP host', 'smtp.gmail.com'],
      ['SMTP port', ''],
      ['SMTP username [ryan@myagencyos.in]', ''],
      ['SMTP password', ''],
      ['The saved password is for smtp.resend.com, not smtp.gmail.com', 'abcd efgh ijkl mnop'],
      ['From address', ''],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(saved('SMTP_PASSWORD')).toBe('abcdefghijklmnop')
    expect(r.transcript).not.toContain(SMTP_PASSWORD)
  })

  it('--smtp keeps the saved password on Enter when the server is the same', async () => {
    save('DATABASE_URL', DB)
    save('SMTP_HOST', 'smtp.gmail.com')
    save('SMTP_USER', 'ryan@myagencyos.in')
    save('SMTP_PASSWORD', 'abcdefghijklmnop')
    save('MAIL_FROM', 'Ryan <ryan@myagencyos.in>')
    const r = await converse(layout(), ['--smtp'], [
      ['SMTP host', ''],
      ['SMTP port', ''],
      ['SMTP username [ryan@myagencyos.in]', ''],
      ['SMTP password', ''],
      ['From address', ''],
    ])
    expect(r.unanswered, r.transcript).toEqual([])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).not.toContain('The saved password is for')
    expect(saved('SMTP_PASSWORD')).toBe('abcdefghijklmnop')
  })

  it('--slack answered none removes a saved webhook', async () => {
    save('DATABASE_URL', DB)
    save('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/T000/B000/old')
    const r = await converse(layout(), ['--slack'], [['Slack webhook URL', 'none']])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('Removed: the opt-out alarm is off.')
    expect(saved('SLACK_WEBHOOK_URL')).toBeUndefined()
    expect(calls()[1]!.env.SLACK_WEBHOOK_URL).toBeUndefined()
  })

  it('--ai answered no removes a saved model choice', async () => {
    save('DATABASE_URL', DB)
    save('LLM_PROVIDER', 'anthropic')
    save('LLM_MODEL', 'claude-haiku-4-5')
    save('LLM_ALLOW_REMOTE_LEAD_DATA', 'true')
    const r = await converse(layout(), ['--ai'], [['Let a model sort replies and polish openers?', 'n']])
    expect(r.status, r.transcript).toBe(0)
    expect(r.transcript).toContain('Off: replies keep the keyword reading and openers the template.')
    expect(saved('LLM_PROVIDER')).toBeUndefined()
    expect(saved('LLM_ALLOW_REMOTE_LEAD_DATA')).toBeUndefined()
  })

  it('--reconfigure keeps a saved model choice, which it does not ask for', async () => {
    save('DATABASE_URL', DB)
    save('LLM_PROVIDER', 'anthropic')
    save('LLM_MODEL', 'claude-haiku-4-5')
    save('LLM_ALLOW_REMOTE_LEAD_DATA', 'true')
    await answered(layout(), ['--reconfigure'], { smtp: false, remember: 'y' })
    expect(saved('LLM_PROVIDER')).toBe('anthropic')
    expect(saved('LLM_ALLOW_REMOTE_LEAD_DATA')).toBe('true')
  })

  it('--reconfigure keeps a saved SECRETS_KEY, which it does not ask for', async () => {
    save('DATABASE_URL', DB)
    save('SECRETS_KEY', SECRETS_KEY)
    const r = await answered(layout(), ['--reconfigure'], { smtp: false, remember: 'y' })
    expect(r.worker.SECRETS_KEY).toBe(SECRETS_KEY)
    expect(saved('SECRETS_KEY')).toBe(SECRETS_KEY)
    expect(r.transcript).not.toContain(SECRETS_KEY)
  })

  describe('off a Mac, where a secret could be neither copied nor saved', () => {
    beforeEach(() => stub('uname', 'echo Linux'))

    it('Enter sends WITHOUT an unsubscribe header, and `new` is not offered', async () => {
      const r = await answered(layout(), [], { smtp: true, unsubscribe: '' })
      expect(r.worker.UNSUBSCRIBE_SECRET).toBeUndefined()
      expect(r.transcript).toContain('WITHOUT an unsubscribe header')
      expect(r.transcript).not.toContain('type new')
      expect(r.transcript).not.toContain('Remember these answers')
      expect(clipboard()).toBeUndefined()
    })

    it('`new` typed anyway makes nothing, and says why', async () => {
      const r = await answered(layout(), [], { smtp: true, unsubscribe: 'new' })
      expect(r.worker.UNSUBSCRIBE_SECRET).toBeUndefined()
      expect(r.transcript).toContain('A new secret is made only on a Mac')
      expect(r.transcript).toContain('WITHOUT an unsubscribe header')
      expect(clipboard()).toBeUndefined()
      expect(readdirSync(keychain)).toEqual([])
    })

    it('Vercel’s value, pasted, is what the worker mails under', async () => {
      const r = await answered(layout(), [], { smtp: true, unsubscribe: VERCEL_UNSUB })
      expect(r.worker.UNSUBSCRIBE_SECRET).toBe(VERCEL_UNSUB)
      expect(r.transcript).toContain('with a one-click unsubscribe link')
    })
  })
})
