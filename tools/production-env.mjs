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
const found = candidates.find(([, value]) => typeof value === 'string' && value.trim() !== '')
if (!found) {
  fail(
    'No database URL: the PRODUCTION_DATABASE_URL secret is not set, and the Vercel project ' +
      'returned no DATABASE_URL (a variable marked Sensitive is never returned by `vercel pull`). ' +
      'Add the secret: Neon’s DIRECT connection string.',
  )
}

const [source, raw] = found
let url
try {
  url = new URL(raw.trim())
} catch {
  fail(`The database URL from ${source} could not be read as a URL.`)
}
mask(raw.trim())
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
