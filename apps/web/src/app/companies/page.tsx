import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import { exportsOpenDealStages, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import {
  OPEN_DEAL_STAGES, applyCompanyQuery, companyQueryString, defaultDir, parseCompanyQuery, readIcp, scanState,
  tierLabel, type CompanyQuery, type CompanySort,
} from '@/lib/company-list'
import { getDb } from '@/lib/db'
import { listCompaniesForOrg, icpForOrg } from '@/lib/queries'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function tierClass(tier: string | null, qualified: boolean): string {
  if (!tier) return 'pill'
  if (tier.startsWith('A')) return 'pill pill-a'
  if (tier.startsWith('B')) return 'pill pill-b'
  return qualified ? 'pill pill-c' : 'pill'
}

/** The form's controls: the house has no generic select style, so one inline style for all of them. */
const control = {
  padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6,
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 13,
} as const

const EXPORT_TITLE = 'Export CSV — internal; never send this to a prospect.'

/** `/companies?…` with this view's filters and the given sort. */
function hrefFor(query: CompanyQuery): string {
  const qs = companyQueryString(query)
  return qs ? `/companies?${qs}` : '/companies'
}

/** A column header that sorts by it — and flips the direction when it already does. */
function SortHeader({ query, sort, label, right }: { query: CompanyQuery; sort: CompanySort; label: string; right?: boolean }) {
  const on = query.sort === sort
  const dir = on ? (query.dir === 'asc' ? 'desc' : 'asc') : defaultDir(sort)
  return (
    <th style={right ? { textAlign: 'right' } : undefined} aria-sort={on ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <a href={hrefFor({ ...query, sort, dir })} style={{ color: 'inherit', textDecoration: 'none' }}>
        {label}{on ? (query.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </a>
    </th>
  )
}

export default async function Companies({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const [rows, icpRow, openDeals, params] = await Promise.all([
    listCompaniesForOrg(user.orgId),
    icpForOrg(user.orgId),
    exportsOpenDealStages(db, user.orgId),
    searchParams,
  ])
  // Guarded: `parseIcpDefinition` throws on a malformed profile, and this page
  // used to call it bare — one bad edit to the ICP made the whole list a 500.
  const { icp, unreadable, staleAfterDays } = readIcp(icpRow?.definition)
  const qualifyAt = icp?.scoring.qualify_at
  const clock = { staleAfterDays, now: new Date() }

  const query = parseCompanyQuery(params)
  const all = rows.map((r) => ({ ...r, openDealStage: openDeals.get(r.companyId) ?? null }))
  const shown = applyCompanyQuery(all, query, clock)

  // The counts describe the whole pipeline; "shown" is what the filters left.
  const scanned = all.filter((r) => r.score !== null)
  const qualified = scanned.filter((r) => r.qualified)
  const unscanned = all.filter((r) => r.lastScanAt === null)

  // The tiers on offer are the ones the list can show, so no option is a view
  // that is always empty. A tier in the URL that no row has is kept, so the
  // select says what the list is filtered on.
  const tiers = [...new Set(all.map(tierLabel).filter((t): t is string => t !== null))].sort()
  if (query.tier && !tiers.includes(query.tier)) tiers.push(query.tier)

  const filtered = shown.length !== all.length
  const qs = companyQueryString(query)

  return (
    <Shell
      user={user}
      current="companies"
      signOut={async () => {
        'use server'
        await signOut({ redirectTo: '/signin' })
      }}
    >
      <h1>
        Companies
        <a href="/companies/import" className="action">Import</a>
        <a
          href={`/api/export/companies${qs ? `?${qs}` : ''}`}
          className="action"
          title={EXPORT_TITLE}
          style={{ marginRight: 8 }}
        >
          Export CSV
        </a>
      </h1>
      <p className="lede">
        {shown.length} of {all.length} shown · {scanned.length} scanned · {qualified.length} qualified
        {qualifyAt === undefined ? null : <> at {qualifyAt}/100</>}
        {unscanned.length ? <> · {unscanned.length} never scanned</> : null}
      </p>

      {unreadable ? (
        <div className="note note-warn" style={{ marginBottom: 16 }}>
          <strong>The active ICP could not be read.</strong> The qualify threshold is not shown, and
          &quot;stale&quot; uses the default of {staleAfterDays} days until the profile is fixed.
        </div>
      ) : null}

      <form method="get" action="/companies" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="Domain or name"
          aria-label="Search domain or name"
          maxLength={200}
          style={{ width: 200 }}
        />
        <select name="tier" defaultValue={query.tier ?? ''} aria-label="Tier" style={control}>
          <option value="">Any tier</option>
          {tiers.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select name="state" defaultValue={query.state ?? ''} aria-label="Scan state" style={control}>
          <option value="">Any scan state</option>
          <option value="never">Never scanned</option>
          <option value="failed">Last scan failed</option>
          <option value="stale">Stale (older than {staleAfterDays} days)</option>
          <option value="fresh">Fresh</option>
        </select>
        <select name="qualified" defaultValue={query.qualified ?? ''} aria-label="Qualified" style={control}>
          <option value="">Qualified or not</option>
          <option value="yes">Qualified</option>
          <option value="no">Scanned, not qualified</option>
        </select>
        <select name="openDeal" defaultValue={query.openDeal ?? ''} aria-label="Open deal" style={control}>
          <option value="">Any deal</option>
          <option value="yes">Has an open deal</option>
          <option value="no">No open deal</option>
          {OPEN_DEAL_STAGES.map((s) => <option key={s} value={s}>Open deal at {s}</option>)}
        </select>
        <select name="sort" defaultValue={query.sort} aria-label="Sort by" style={control}>
          <option value="domain">Sort: domain</option>
          <option value="name">Sort: name</option>
          <option value="score">Sort: score</option>
          <option value="lastScanAt">Sort: last scan</option>
        </select>
        {/* Empty is "the sort's own order": highest score and newest scan first, names A→Z.
            Pre-selecting the old direction would sort by score LOWEST first on a fresh pick. */}
        <select name="dir" defaultValue={query.dir === defaultDir(query.sort) ? '' : query.dir} aria-label="Direction" style={control}>
          <option value="">Natural order</option>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
        <button type="submit" style={{ width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13 }}>Apply</button>
        {qs ? <a href="/companies" style={{ fontSize: 13 }}>Clear</a> : null}
      </form>

      <table>
        <thead>
          <tr>
            <SortHeader query={query} sort="name" label="Company" />
            <SortHeader query={query} sort="domain" label="Domain" />
            <SortHeader query={query} sort="score" label="Score" right />
            <th>Tier</th>
            <SortHeader query={query} sort="lastScanAt" label="Last scan" />
            <th>Open deal</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.companyId}>
              <td><a href={`/companies/${r.domain}`}>{r.name ?? r.domain}</a></td>
              <td className="mono">{r.domain}</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {/* Never scanned means no number — not a zero that reads as a result. */}
                {r.score === null ? <span className="muted">—</span> : r.score}
              </td>
              <td>
                {r.disqualifiedReason ? (
                  <span className="pill" title={r.disqualifiedReason}>disqualified</span>
                ) : r.score === null ? (
                  <span className="muted">not scanned</span>
                ) : (
                  <span className={tierClass(r.tier, r.qualified)}>{r.tier || 'below threshold'}</span>
                )}
              </td>
              <td className="mono muted">
                {r.lastScanAt ? new Date(r.lastScanAt).toISOString().slice(0, 10) : '—'}
                {r.lastScanOk === false ? ' (failed)' : ''}
                {/* From the scan's own time, never from findings.stale. */}
                {scanState(r, clock) === 'stale' ? ' (stale)' : ''}
              </td>
              <td>
                {r.openDealStage ? <span className="tag" style={{ marginLeft: 0 }}>{r.openDealStage}</span> : <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {all.length === 0 ? (
        <p className="muted" style={{ marginTop: 16 }}>
          No companies yet. <a href="/companies/import">Import a list</a> to start.
        </p>
      ) : filtered && shown.length === 0 ? (
        <p className="muted" style={{ marginTop: 16 }}>
          No company matches these filters. <a href="/companies">Clear them</a>.
        </p>
      ) : null}

      {unscanned.length ? (
        <div className="note" style={{ marginTop: 22 }}>
          <strong>{unscanned.length} companies have never been scanned.</strong> They have no score
          and no findings, and the table says so rather than showing a zero. Run{' '}
          <code>npm run scan</code> to collect their public surface.
        </div>
      ) : null}

      <p className="muted" style={{ marginTop: 22, fontSize: 12.5 }}>
        Exports are internal and each one is recorded in the audit log:{' '}
        <a href={`/api/export/companies${qs ? `?${qs}` : ''}`} title={EXPORT_TITLE}>this view</a>
        {' · '}
        <a href="/api/export/findings" title={EXPORT_TITLE}>findings from each company&apos;s latest scan</a>
        {can(principal, 'contacts:read') ? (
          <>
            {' · '}
            <a href="/api/export/consents" title={EXPORT_TITLE}>the consent ledger</a>
          </>
        ) : null}
        . A blank cell means not observed, never scanned or never asked — it never means no.
      </p>
    </Shell>
  )
}
