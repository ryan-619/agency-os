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
 *   RUN_ID=… node tools/vercel-env.mjs superseded <FROM> <TO>
 *                                              exit 0 when FROM holds a record
 *                                              that a LATER run wrote AND
 *                                              promoted to TO; prints that
 *                                              run's id whenever FROM holds
 *                                              a later run's record
 *   RUN_ID=… node tools/vercel-env.mjs promote <FROM> <TO>
 *                                              set TO (encrypted) to what run
 *                                              RUN_ID recorded in FROM
 *
 * `has`, `equals`, `pending` and `superseded` answer 1 for "no" and 2 when the API could
 * not be asked — and a caller must never read a 2 as "no" (review round 6,
 * [10]): the worker action did, and a transient API error rotated the
 * worker's token. `equals` is for the one non-secret value the worker
 * action reads back (its wiring marker), and compares without printing
 * either side.
 *
 * "Could not be asked" includes a request that never got an answer — a DNS
 * failure, a reset connection, the 15 s timeout — and an answer whose body
 * could not be read (review round 9, [8]). A rejected `fetch` used to escape
 * as an unhandled rejection, which Node exits with 1: "no". The worker-web
 * job then read a timeout as "nothing of this run is waiting", skipped the
 * redeploy and went green with the live web app on the old token.
 *
 * `pending` and `promote` carry that marker from the Production workflow's
 * `worker` job, which holds the worker's secrets, to its `worker-web` job,
 * which redeploys the web app and must write the marker LAST (review round
 * 8, [5]). A record is "<run id>/<value>", written with `set`; only the run
 * that wrote it can promote it, so a re-run of an old job never records a
 * newer run's wiring. `superseded` tells the one innocent way a run's record
 * can be missing — a later run has written its own since, as when an old
 * run's second job is re-run — from a record that should be there and is
 * not (review round 9, [8]). GitHub's run ids grow, so "later" is a larger
 * id. A later run's record is written by that run's FIRST job, so it says
 * only that the run set a newer token on Fly and Vercel — not that its web
 * job redeployed the web app: `superseded` answers 0 only when that record
 * has also been promoted to TO, and 1 otherwise, printing the run's id for
 * the caller to name (review round 10, [3]). An empty record ("<run id>/",
 * Fly gave no digest) can never be promoted, so whether its web job
 * finished cannot be checked: that is 0, with a warning. The id — a
 * workflow run's, which carries nothing of the record's value — is the one
 * thing printed on stdout, and never on a 2. `promote` answers 0 when TO
 * was set, 1 when there is nothing of this run's to record (no record,
 * another run's, or an empty value), and 2 when the API could not be asked
 * or refused the write. It prints neither value.
 *
 * The VALUE travels in the environment, never on argv (a process list shows
 * argv). Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID, which
 * tools/vercel-project.mjs finds. Prints names and status codes only.
 */
const { VERCEL_TOKEN: token, VERCEL_ORG_ID: org, VERCEL_PROJECT_ID: project, VALUE: value, RUN_ID: runId } = process.env
const [cmd, key, type] = process.argv.slice(2)
if (!token || !org || !project || !cmd || !key) {
  console.error(
    'usage: VALUE=… node tools/vercel-env.mjs set <KEY> <sensitive|encrypted> | has <KEY> | equals <KEY> | pending <KEY> | superseded <FROM> <TO> | promote <FROM> <TO>',
  )
  process.exit(2)
}
// A personal account's projects take no teamId; a team's need it.
const scope = org.startsWith('team_') ? `teamId=${encodeURIComponent(org)}` : ''

/**
 * Why a request got no answer, as words that carry nothing from it: the
 * error's class and, for a network failure, its system code. Never its
 * message or cause text, which can quote the URL.
 */
function unanswered(err) {
  const name = err instanceof Error ? err.name : 'Error'
  const code = err instanceof Error && typeof err.cause?.code === 'string' ? err.cause.code : null
  return code ? `${name} (${code})` : name
}

/**
 * One request. `json` is null when the body was not JSON; `unreadable` says
 * the body could not be READ at all — the timeout fired mid-body, or the
 * connection dropped — which the readers below never take for an answer.
 * A request that got no answer stops the script here, with 2.
 */
async function api(method, path, body) {
  const sep = path.includes('?') ? '&' : '?'
  let res
  try {
    res = await fetch(`https://api.vercel.com${path}${scope ? sep + scope : ''}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    console.error(`::error::the Vercel API could not be asked (${method} ${path.split('?')[0]}): ${unanswered(err)}`)
    process.exit(2)
  }
  let text = null
  try {
    text = await res.text()
  } catch {
    text = null
  }
  let json = null
  try {
    json = text === null ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, unreadable: text === null, code: json?.error?.code ?? null }
}

/** The production entry for `name`, or null; exits 2 when the list cannot be read. */
async function productionEntry(name = key) {
  const r = await api('GET', `/v10/projects/${encodeURIComponent(project)}/env`)
  if (r.status !== 200) {
    console.error(`::error::listing the project's variables failed: HTTP ${r.status}${r.code ? ` (${r.code})` : ''}`)
    process.exit(2)
  }
  // A list that did not arrive whole is not a list without the name.
  if (!Array.isArray(r.json?.envs)) {
    console.error(`::error::listing the project's variables failed: the answer could not be read${r.unreadable ? ' (it was cut off)' : ''}`)
    process.exit(2)
  }
  return (
    r.json.envs.find(
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
  // An answer that could not be read is not a value that never comes back.
  if (r.json === null || typeof r.json !== 'object') {
    console.error(`::error::reading ${name} failed: the answer could not be read${r.unreadable ? ' (it was cut off)' : ''}`)
    process.exit(2)
  }
  return typeof r.json.value === 'string' ? r.json.value : null
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

/** RUN_ID, checked: a workflow run id, or the script stops with 2. */
function thisRun() {
  if (!runId || !/^[0-9]+$/.test(runId)) {
    console.error('::error::RUN_ID is not a workflow run id')
    process.exit(2)
  }
  return runId
}

/** What run RUN_ID recorded in `name` — '' for an empty record — or null when it recorded nothing there. */
async function recordOfThisRun(name) {
  const prefix = `${thisRun()}/`
  const stored = await productionValue(name)
  return typeof stored === 'string' && stored.startsWith(prefix) ? stored.slice(prefix.length) : null
}

/**
 * The record `name` holds when a run with a larger id than RUN_ID's wrote it
 * — that run's id, and what it recorded ('' for an empty record) — or null.
 */
async function recordOfALaterRun(name) {
  const mine = BigInt(thisRun())
  const stored = await productionValue(name)
  const m = typeof stored === 'string' ? /^([0-9]+)\/(.*)$/s.exec(stored) : null
  return m !== null && BigInt(m[1]) > mine ? { run: m[1], record: m[2] } : null
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

if (cmd === 'superseded') {
  if (!type) {
    console.error('::error::superseded needs the variable a record is promoted to: superseded <FROM> <TO>')
    process.exit(2)
  }
  const later = await recordOfALaterRun(key)
  if (!later) process.exit(1)
  const promoted = later.record === '' || (await productionValue(type)) === later.record
  console.log(later.run)
  if (later.record === '') {
    console.error(
      `::warning::run ${later.run} left ${key} with no digest, so whether its web job finished cannot be checked; if it did not, re-run that run's worker-web job, or the worker action`,
    )
  }
  process.exit(promoted ? 0 : 1)
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
