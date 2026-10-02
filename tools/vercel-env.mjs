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
 *   RUN_ID=… node tools/vercel-env.mjs pending <KEY>
 *                                              exit 0 when KEY holds a record
 *                                              that run RUN_ID wrote
 *   RUN_ID=… node tools/vercel-env.mjs promote <FROM> <TO>
 *                                              set TO (encrypted) to what run
 *                                              RUN_ID recorded in FROM
 *
 * `has`, `equals` and `pending` answer 1 for "no" and 2 when the API could
 * not be asked — and a caller must never read a 2 as "no" (review round 6,
 * [10]): the worker action did, and a transient API error rotated the
 * worker's token. `equals` is for the one non-secret value the worker
 * action reads back (its wiring marker), and compares without printing
 * either side.
 *
 * `pending` and `promote` carry that marker from the Production workflow's
 * `worker` job, which holds the worker's secrets, to its `worker-web` job,
 * which redeploys the web app and must write the marker LAST (review round
 * 8, [5]). A record is "<run id>/<value>", written with `set`; only the run
 * that wrote it can promote it, so a re-run of an old job never records a
 * newer run's wiring. `promote` answers 0 when TO was set, 1 when there is
 * nothing of this run's to record (no record, another run's, or an empty
 * value), and 2 when the API could not be asked or refused the write. It
 * prints neither value.
 *
 * The VALUE travels in the environment, never on argv (a process list shows
 * argv). Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID, which
 * tools/vercel-project.mjs finds. Prints names and status codes only.
 */
const { VERCEL_TOKEN: token, VERCEL_ORG_ID: org, VERCEL_PROJECT_ID: project, VALUE: value, RUN_ID: runId } = process.env
const [cmd, key, type] = process.argv.slice(2)
if (!token || !org || !project || !cmd || !key) {
  console.error(
    'usage: VALUE=… node tools/vercel-env.mjs set <KEY> <sensitive|encrypted> | has <KEY> | equals <KEY> | pending <KEY> | promote <FROM> <TO>',
  )
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

/** The production entry for `name`, or null; exits 2 when the list cannot be read. */
async function productionEntry(name = key) {
  const r = await api('GET', `/v10/projects/${encodeURIComponent(project)}/env`)
  if (r.status !== 200) {
    console.error(`::error::listing the project's variables failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(2)
  }
  return (
    (r.json?.envs ?? []).find(
      (e) => e.key === name && (Array.isArray(e.target) ? e.target.includes('production') : e.target === 'production'),
    ) ?? null
  )
}

/**
 * The production value of `name`, or null when there is no such variable or
 * its value never comes back; exits 2 when the API could not be asked.
 */
async function productionValue(name = key) {
  const entry = await productionEntry(name)
  if (!entry) return null
  // The list does not carry values; this read returns the decrypted one for
  // an `encrypted` variable (a `sensitive` one never comes back, and so
  // never equals anything).
  const r = await api('GET', `/v1/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(entry.id)}`)
  if (r.status !== 200) {
    console.error(`::error::reading ${name} failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(2)
  }
  return typeof r.json?.value === 'string' ? r.json.value : null
}

/** Upsert a production variable; exits `failure` when Vercel refuses it. */
async function setProduction(name, to, kind, failure) {
  const r = await api('POST', `/v10/projects/${encodeURIComponent(project)}/env?upsert=true`, {
    key: name,
    value: to,
    type: kind === 'sensitive' ? 'sensitive' : 'encrypted',
    target: ['production'],
  })
  if (r.status !== 200 && r.status !== 201) {
    console.error(`::error::setting ${name} on Vercel failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(failure)
  }
  console.log(`vercel: ${name} set for production`)
}

/** What run RUN_ID recorded in `name` — '' for an empty record — or null when it recorded nothing there. */
async function recordOfThisRun(name) {
  if (!runId || !/^[0-9]+$/.test(runId)) {
    console.error('::error::RUN_ID is not a workflow run id')
    process.exit(2)
  }
  const stored = await productionValue(name)
  const prefix = `${runId}/`
  return typeof stored === 'string' && stored.startsWith(prefix) ? stored.slice(prefix.length) : null
}

if (cmd === 'has') {
  process.exit((await productionEntry()) ? 0 : 1)
}

if (cmd === 'equals') {
  if (typeof value !== 'string' || value === '') {
    console.error(`::error::no VALUE to compare ${key} with`)
    process.exit(2)
  }
  const stored = await productionValue()
  process.exit(stored === value ? 0 : 1)
}

if (cmd === 'pending') {
  process.exit((await recordOfThisRun(key)) === null ? 1 : 0)
}

if (cmd === 'promote') {
  if (!type) {
    console.error('::error::promote needs the variable to set: promote <FROM> <TO>')
    process.exit(2)
  }
  const record = await recordOfThisRun(key)
  if (!record) process.exit(1)
  await setProduction(type, record, 'encrypted', 2)
  process.exit(0)
}

if (cmd === 'set') {
  if (typeof value !== 'string' || value === '') {
    console.error(`::error::no VALUE for ${key}`)
    process.exit(2)
  }
  await setProduction(key, value, type, 1)
  process.exit(0)
}

console.error(`unknown command: ${cmd}`)
process.exit(2)
