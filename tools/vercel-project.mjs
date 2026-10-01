#!/usr/bin/env node
/**
 * Find the Vercel project `tools/production.sh` deploys, from the token
 * alone, and print `VERCEL_ORG_ID=… VERCEL_PROJECT_ID=…` lines for the shell
 * to read — ids, which are not credentials. `vercel link --yes` asks for the
 * token's USER first and fails "User not found" for a token scoped to a team,
 * so this asks the API for the project under every scope the token reaches:
 * the personal account, then each team.
 *
 * Prints status codes and Vercel's error codes on stderr when nothing is
 * found, never a response body (a body can echo request details).
 *
 *   node tools/vercel-project.mjs <project-name> [team-id-or-slug]
 */
const token = process.env.VERCEL_TOKEN ?? ''
const [name, wantedTeam] = process.argv.slice(2)
if (!token || !name) {
  console.error('usage: VERCEL_TOKEN=… node tools/vercel-project.mjs <project> [team]')
  process.exit(2)
}

async function get(path) {
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, code: body?.error?.code ?? null }
}

const notes = []
const user = await get('/v2/user')
notes.push(`account lookup: HTTP ${user.status}${user.code ? ` (${user.code})` : ''}`)

const teams = await get('/v2/teams?limit=100')
notes.push(`team list: HTTP ${teams.status}${teams.code ? ` (${teams.code})` : ''}`)
const teamList = Array.isArray(teams.body?.teams) ? teams.body.teams : []

/** Scopes to try: the named team only, if one was given; else personal, then every team. */
const scopes = wantedTeam
  ? [{ label: `team ${wantedTeam}`, query: `?teamId=${encodeURIComponent(wantedTeam)}` }]
  : [
      { label: 'personal account', query: '' },
      ...teamList.map((t) => ({ label: `team ${t.slug}`, query: `?teamId=${encodeURIComponent(t.id)}` })),
    ]

for (const scope of scopes) {
  const p = await get(`/v9/projects/${encodeURIComponent(name)}${scope.query}`)
  notes.push(`project '${name}' in ${scope.label}: HTTP ${p.status}${p.code ? ` (${p.code})` : ''}`)
  if (p.status === 200 && p.body?.id && p.body?.accountId) {
    console.error(`found project '${name}' in ${scope.label}`)
    process.stdout.write(`VERCEL_ORG_ID=${p.body.accountId}\nVERCEL_PROJECT_ID=${p.body.id}\n`)
    process.exit(0)
  }
}

for (const n of notes) console.error(n)
const invalid = [user, teams].every((r) => r.status === 401 || r.status === 403)
console.error(
  invalid && teamList.length === 0
    ? '::error::Vercel refused this token everywhere. It is mistyped, expired or revoked: create a new one at https://vercel.com/account/tokens and paste the value Vercel shows once, as the VERCEL_TOKEN secret.'
    : `::error::The token works, but no scope it reaches holds a project named '${name}'. Create the token with the scope that owns the project, or set VERCEL_TEAM.`,
)
process.exit(1)
