#!/usr/bin/env node
/**
 * The two jobs tools/production.sh needs done to an environment file that
 * holds production credentials, without a shell ever echoing one (§2.3).
 *
 *   mask <env-file>
 *     Print a GitHub `::add-mask::` command for every line of every value in
 *     the file `vercel pull` wrote, so nothing it holds can appear in the log.
 *
 *   database-url <env-file> <out-file>
 *     Choose the connection string migrations run on, write it to <out-file>
 *     (mode 600), mask it, and print where it came from and `host:port/db` —
 *     never the string. In order: the PRODUCTION_DATABASE_URL secret; the
 *     unpooled URL Neon's Vercel integration sets (DATABASE_URL_UNPOOLED,
 *     POSTGRES_URL_NON_POOLING); else Vercel's DATABASE_URL — the POOLED one
 *     (DEPLOYING.md §5) — with `-pooler` taken off the endpoint's first label,
 *     which is how Neon names the direct host of the same endpoint.
 *
 * Node's own `util.parseEnv`, so no dependency reads the file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const [cmd, envFile, outFile] = process.argv.slice(2)

function readEnv(path) {
  try {
    return parseEnv(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function mask(value) {
  for (const line of String(value).split(/\r?\n/)) {
    if (line.trim().length >= 4) process.stdout.write(`::add-mask::${line}\n`)
  }
}

function fail(message) {
  process.stdout.write(`::error::${message}\n`)
  process.exit(1)
}

if (cmd === 'mask') {
  for (const value of Object.values(readEnv(envFile))) mask(value)
  process.exit(0)
}

if (cmd !== 'database-url' || !outFile) fail('usage: production-env.mjs mask <file> | database-url <file> <out>')

const pulled = readEnv(envFile)
const candidates = [
  ['the PRODUCTION_DATABASE_URL secret', process.env.PRODUCTION_DATABASE_URL],
  ['Vercel DATABASE_URL_UNPOOLED', pulled.DATABASE_URL_UNPOOLED],
  ['Vercel POSTGRES_URL_NON_POOLING', pulled.POSTGRES_URL_NON_POOLING],
  ['Vercel DATABASE_URL', pulled.DATABASE_URL],
]
/**
 * What a value looks like, for the log, without what it says: its length,
 * its scheme when it has one, and the characters that would stop it parsing.
 */
function shape(value) {
  const v = String(value)
  const scheme = /^([a-z][a-z0-9+.-]{0,14}):\/\//i.exec(v.trim())?.[1]
  const marks = [
    scheme ? `scheme ${scheme}` : 'no scheme',
    `${v.length} characters`,
    /^\s|\s$/.test(v) ? 'leading or trailing space' : '',
    /\s/.test(v.trim()) ? 'a space or line break inside' : '',
    /^["']|["']$/.test(v.trim()) ? 'wrapped in quotes' : '',
  ]
  return marks.filter(Boolean).join(', ')
}

let source = ''
let raw = ''
let url
const skipped = []
for (const [label, value] of candidates) {
  if (typeof value !== 'string' || value.trim() === '') continue
  try {
    url = new URL(value.trim().replace(/^["']|["']$/g, ''))
    if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('not a postgres URL')
    source = label
    raw = value.trim().replace(/^["']|["']$/g, '')
    break
  } catch {
    url = undefined
    skipped.push(`${label} is not a postgres URL (${shape(value)})`)
  }
}
for (const line of skipped) process.stdout.write(`skipped: ${line}\n`)
if (!url) {
  fail(
    skipped.length > 0
      ? 'No usable database URL: every candidate above was set but none is a postgres:// URL. Add the PRODUCTION_DATABASE_URL secret: Neon’s DIRECT connection string.'
      : 'No database URL: the PRODUCTION_DATABASE_URL secret is not set, and the Vercel project ' +
          'returned no DATABASE_URL (a variable marked Sensitive is never returned by `vercel pull`). ' +
          'Add the secret: Neon’s DIRECT connection string.',
  )
}
mask(raw)
if (url.password) {
  mask(url.password)
  mask(decodeURIComponent(url.password))
}

let derived = ''
const [first, ...rest] = url.hostname.split('.')
if (source === 'Vercel DATABASE_URL' && first.endsWith('-pooler')) {
  url.hostname = [first.slice(0, -'-pooler'.length), ...rest].join('.')
  derived = ' (direct host: -pooler removed)'
}
const finalUrl = url.toString()
mask(finalUrl)
writeFileSync(outFile, finalUrl, { mode: 0o600 })

const port = url.port || '5432'
const db = url.pathname.replace(/^\//, '') || '(default)'
process.stdout.write(`database: ${url.hostname}:${port}/${db}, from ${source}${derived}\n`)
