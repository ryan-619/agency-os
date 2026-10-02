#!/usr/bin/env node
/**
 * Set one production environment variable on the Vercel project, or list
 * which names exist — for tools/production.sh, which wires the web app to
 * the worker (AGENT_URL, AGENT_INTERNAL_TOKEN) without a person copying a
 * token between two dashboards.
 *
 *   VALUE=… node tools/vercel-env.mjs set <KEY> <sensitive|encrypted>
 *   node tools/vercel-env.mjs has <KEY>        exit 0 when the name exists
 *   VALUE=… node tools/vercel-env.mjs equals <KEY>
 *                                              exit 0 when its value is VALUE
 *
 * `has` and `equals` answer 1 for "no" and 2 when the API could not be
 * asked — and a caller must never read a 2 as "no" (review round 6, [10]):
 * the worker action did, and a transient API error rotated the worker's
 * token. `equals` is for the one non-secret value the worker action reads
 * back (its wiring marker), and compares without printing either side.
 *
 * The VALUE travels in the environment, never on argv (a process list shows
 * argv). Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID, which
 * tools/vercel-project.mjs finds. Prints names and status codes only.
 */
const { VERCEL_TOKEN: token, VERCEL_ORG_ID: org, VERCEL_PROJECT_ID: project, VALUE: value } = process.env
const [cmd, key, type] = process.argv.slice(2)
if (!token || !org || !project || !cmd || !key) {
  console.error('usage: VALUE=… node tools/vercel-env.mjs set <KEY> <sensitive|encrypted> | has <KEY> | equals <KEY>')
  process.exit(2)
}
// A personal account's projects take no teamId; a team's need it.
const scope = org.startsWith('team_') ? `teamId=${encodeURIComponent(org)}` : ''

async function api(method, path, body) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`https://api.vercel.com${path}${scope ? sep + scope : ''}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json, code: json?.error?.code ?? null }
}

/** The production entry for KEY, or null; exits 2 when the list cannot be read. */
async function productionEntry() {
  const r = await api('GET', `/v10/projects/${encodeURIComponent(project)}/env`)
  if (r.status !== 200) {
    console.error(`::error::listing the project's variables failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(2)
  }
  return (
    (r.json?.envs ?? []).find(
      (e) => e.key === key && (Array.isArray(e.target) ? e.target.includes('production') : e.target === 'production'),
    ) ?? null
  )
}

if (cmd === 'has') {
  process.exit((await productionEntry()) ? 0 : 1)
}

if (cmd === 'equals') {
  if (typeof value !== 'string' || value === '') {
    console.error(`::error::no VALUE to compare ${key} with`)
    process.exit(2)
  }
  const entry = await productionEntry()
  if (!entry) process.exit(1)
  // The list does not carry values; this read returns the decrypted one for
  // an `encrypted` variable (a `sensitive` one never comes back, and so
  // never equals anything).
  const r = await api('GET', `/v1/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(entry.id)}`)
  if (r.status !== 200) {
    console.error(`::error::reading ${key} failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(2)
  }
  process.exit(typeof r.json?.value === 'string' && r.json.value === value ? 0 : 1)
}

if (cmd === 'set') {
  if (typeof value !== 'string' || value === '') {
    console.error(`::error::no VALUE for ${key}`)
    process.exit(2)
  }
  const r = await api('POST', `/v10/projects/${encodeURIComponent(project)}/env?upsert=true`, {
    key,
    value,
    type: type === 'sensitive' ? 'sensitive' : 'encrypted',
    target: ['production'],
  })
  if (r.status !== 200 && r.status !== 201) {
    console.error(`::error::setting ${key} on Vercel failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(1)
  }
  console.log(`vercel: ${key} set for production`)
  process.exit(0)
}

console.error(`unknown command: ${cmd}`)
process.exit(2)
