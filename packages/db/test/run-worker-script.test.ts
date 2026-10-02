/**
 * tools/run-worker.sh — the worker on the operator's own machine, the
 * deployment for an agency that has not rented a server.
 *
 * It is driven here against stubs: `uname` (to read as a Mac), `security`
 * (a Keychain kept in files), `caffeinate` (runs its command), `node` (in
 * front of the real one, for the version check) and `npx` (records what it
 * was asked to run and the NAMES and values in its environment, then stops).
 * So the REAL script runs, and nothing reaches a database, a mailbox or the
 * network. Only the path that reads saved answers is driven: the prompts need
 * a terminal, which a test has none of.
 *
 * What is pinned:
 *  - a saved answer reaches the worker's ENVIRONMENT, never any process's
 *    argument list (§2.3: `ps` shows argv to every user on the machine) —
 *    the Keychain stub records every argv it is given;
 *  - port 465 is implicit TLS (`SMTP_SECURE=true`), anything else STARTTLS;
 *  - the packages are built before the worker starts, because they run as
 *    compiled JavaScript and a fresh checkout or a `git pull` would otherwise
 *    run stale code or none;
 *  - Neon's pooled endpoint is refused, saved or not;
 *  - `--forget` removes every saved answer.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

let dir: string
let bin: string
let keychain: string
let logs: string

function stub(name: string, body: string): void {
  const path = join(bin, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

/** A checkout the script can `cd` into: tools/run-worker.sh and a node_modules. */
function layout(): string {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'tools'), { recursive: true })
  mkdirSync(join(repo, 'node_modules'))
  writeFileSync(join(repo, 'tools/run-worker.sh'), readFileSync(script))
  chmodSync(join(repo, 'tools/run-worker.sh'), 0o755)
  return repo
}

function save(name: string, value: string): void {
  writeFileSync(join(keychain, name), Buffer.from(value).toString('base64'))
}

function run(repo: string, args: string[] = []) {
  return spawnSync('bash', [join(repo, 'tools/run-worker.sh'), ...args], {
    cwd: repo,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, KEYCHAIN: keychain, LOGS: logs },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function calls(): { argv: string; env: Record<string, string> }[] {
  if (!existsSync(join(logs, 'npx'))) return []
  return readFileSync(join(logs, 'npx'), 'utf8').trim().split('\n\0\n').filter(Boolean).map((block) => {
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
  stub('pbcopy', 'cat > /dev/null')
  // npx: record the argv on one line, then every NAME=value, then stop.
  stub('npx', '{ printf "%s\\n" "$*"; env; printf "\\n\\0\\n"; } >> "$LOGS/npx"; exit 0')
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
    // Built first, then the worker — and both from npx, the only thing started.
    expect(c.map((x) => x.argv)).toEqual(['tsc --build', 'tsx apps/agent/src/index.ts'])
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

  it('refuses the pooled endpoint, saved or not, before anything is built or started', () => {
    const repo = layout()
    save('DATABASE_URL', DB.replace('ep-quiet-sky-123.', 'ep-quiet-sky-123-pooler.'))
    const r = run(repo)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("POOLED endpoint")
    expect(calls()).toEqual([])
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

  it('forgets every saved answer with --forget', () => {
    const repo = layout()
    save('DATABASE_URL', DB)
    save('SMTP_PASSWORD', SMTP_PASSWORD)
    const r = run(repo, ['--forget'])
    expect(r.status).toBe(0)
    expect(readdirSync(keychain)).toEqual([])
    expect(calls()).toEqual([])
  })

  it('refuses an argument it does not know', () => {
    const r = run(layout(), ['--save-everything'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage')
  })
})
