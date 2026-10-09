import { redirect } from 'next/navigation'
import { icpProfilesList, type AgencyDb, type IcpProfileRow } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { getDb } from '@/lib/db'
import { activeProfilesNote, icpView, type IcpView } from '@/lib/icp-view'

/**
 * Settings → ICP: the profile every score is computed against, READ ONLY
 * (§2.2).
 *
 * There is no edit control, and the page says why rather than leaving a
 * missing button to be read as a missing feature: a stored score names the
 * definition it was computed from, and every finding carries the weight that
 * definition gave it. Editing in place would change what every number on
 * every company page means without changing any of them. A changed ICP is a
 * new profile and a re-scan, never an UPDATE — and since 0021 that is built,
 * in chat: `create_icp` derives a new profile (stored inactive), and
 * `activate_icp`, approved by a person on a card, switches to it.
 *
 * Every profile the org has is listed, not just the active one. Until 0021
 * `active` had no partial-unique index and the scanner reads the first active
 * row with no ORDER BY, so two active rows were a choice nobody made; 0021's
 * index allows one, and the page still says so if more than one is active.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function IcpPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const rows = await icpProfilesList(getDb() as unknown as AgencyDb, user.orgId)
  const warning = activeProfilesNote(rows)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="icp" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Ideal customer profile</h1>
      <p className="lede">
        The signals, weights and thresholds every company is scored against, exactly as stored.
      </p>

      <div className="note">
        <strong>There is no edit control here, on purpose.</strong> Every stored score names the definition it
        was computed from, and every finding carries the weight this definition gave it. Editing a definition in
        place would change what each of those numbers means without changing any of them — a 62 that qualified
        at 45 silently becomes a different claim at 65. So a changed ICP is a new profile, with the old one kept
        for the scores that name it: ask in Chat — &ldquo;create a profile for SaaS companies in India with 10 to
        500 staff&rdquo; — and the agent derives one from the active profile. Switching to it waits for a
        person&rsquo;s approval, and each company is re-scanned under it before its next proposal.
      </div>

      {warning ? (
        <div className="note note-warn" style={{ marginTop: 12 }}>
          <strong>{warning}</strong>
        </div>
      ) : null}

      {rows.map((row) => (
        <Profile key={row.id} row={row} />
      ))}
    </Shell>
  )
}

function Profile({ row }: { row: IcpProfileRow }) {
  const result = icpView(row.definition)
  return (
    <section style={{ marginTop: 30 }}>
      <h2 style={{ marginTop: 0 }}>
        {row.name}{' '}
        <span className={row.active ? 'tag on' : 'tag'} style={{ fontWeight: 400 }}>
          {row.active ? 'active' : 'inactive'}
        </span>
      </h2>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
        {row.scores === 0
          ? 'No stored score names this profile.'
          : `${row.scores} stored score${row.scores === 1 ? '' : 's'} name${row.scores === 1 ? 's' : ''} this profile.`}{' '}
        Created <When iso={row.createdAt.toISOString()} mode="date" />
        {row.updatedAt ? <> · last changed <When iso={row.updatedAt.toISOString()} mode="date" /></> : null}.
      </p>
      {result.ok ? (
        <Definition v={result.view} />
      ) : (
        <div className="note note-warn">
          <strong>This definition does not parse, so nothing can be scored against it.</strong>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 12.5 }}>{result.problem}</pre>
        </div>
      )}
    </section>
  )
}

function Definition({ v }: { v: IcpView }) {
  const o = v.outreach
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><strong>{v.label}</strong></p>
      {v.positioning ? <p className="muted" style={{ margin: '0 0 12px', fontSize: 13.5 }}>{v.positioning}</p> : null}

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Signals</h3>
      <table>
        <thead>
          <tr><th>#</th><th>Signal</th><th>Weight</th><th>Share</th><th>Why it matters</th></tr>
        </thead>
        <tbody>
          {v.signals.map((s, i) => (
            <tr key={s.key}>
              <td className="mono">{s.order ?? i + 1}</td>
              <td className="mono">{s.key}</td>
              <td className="mono">{s.weight}</td>
              <td className="mono">{s.sharePct}%</td>
              <td>{s.why}</td>
            </tr>
          ))}
          <tr>
            <td />
            <td><strong>Total</strong></td>
            <td className="mono"><strong>{v.totalWeight}</strong></td>
            <td />
            <td className="muted">
              A score is the observed gaps&apos; weight over the observed signals&apos; weight, on 0–100. A signal the
              scan could not observe is left out of both.
            </td>
          </tr>
        </tbody>
      </table>
      {v.ordering === 'key_name' ? (
        <p className="muted" style={{ fontSize: 12.5 }}>
          This profile gives its signals no <code>order</code>, so they are listed by key name. The database does not
          keep the order they were written in.
        </p>
      ) : null}

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Scoring</h3>
      <p style={{ margin: '0 0 8px' }}>
        Qualifies at <span className="mono">{v.qualifyAt} / 100</span>.
      </p>
      {v.tiers.length > 0 ? (
        <p style={{ margin: '0 0 8px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {v.tiers.map((t) => (
            <span key={t.name} className={`pill ${t.pill}`}>{t.name} · {t.range}</span>
          ))}
        </p>
      ) : (
        <p className="muted" style={{ margin: '0 0 8px' }}>No tiers.</p>
      )}
      {v.scoringNote ? <p className="muted" style={{ fontSize: 13 }}>{v.scoringNote}</p> : null}

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Disqualifiers</h3>
      {v.disqualifiers.length > 0 ? (
        <table>
          <tbody>
            {v.disqualifiers.map((d) => (
              <tr key={d.key}>
                <td className="mono" style={{ width: 200 }}>{d.key}</td>
                <td>{d.why}</td>
                <td style={{ width: 150 }}>
                  {d.applied ? (
                    <>
                      <span className="tag on">applied by the scorer</span>
                      {d.when ? <div className="muted" style={{ fontSize: 11.5 }}>{d.when}</div> : null}
                    </>
                  ) : (
                    <span className="tag warn">checked by nothing</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">None.</p>
      )}
      {v.disqualifiers.some((d) => !d.applied) ? (
        <p className="muted" style={{ fontSize: 12.5 }}>
          A disqualifier marked &lsquo;checked by nothing&rsquo; is written in this profile, and no scan or score
          evaluates it. It describes who the agency does not sell to; a person applies it.
        </p>
      ) : null}

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Freshness</h3>
      <p style={{ margin: '0 0 6px' }}>
        A finding is stale after <span className="mono">{v.staleAfterDays}</span> days
        {v.staleAfterDaysRefused !== null
          ? ` — this profile sets ${v.staleAfterDaysRefused}, which is not a positive number of days, so every reader uses the product default`
          : v.staleAfterDaysIsDefault
            ? ' — this profile sets none, so the product default applies'
            : ''}. Stale
        evidence is never quoted in a draft or a proposal until the company is re-scanned.
      </p>
      {v.freshnessNote ? <p className="muted" style={{ fontSize: 13 }}>{v.freshnessNote}</p> : null}

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Outreach, as the profile describes it</h3>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
        None of this is enforced from here. The send path applies each campaign&apos;s own channel, daily cap and
        quiet hours; sending without a person is a campaign switch only an owner can turn on; and cold voice and
        SMS are refused whatever any profile says.
      </p>
      {o ? (
        <table>
          <tbody>
            <tr><th style={{ width: 200 }}>Channels</th><td className="mono">{o.channels?.join(', ') ?? '—'}</td></tr>
            <tr><th>Daily cap</th><td className="mono">{o.maxPerDay ?? '—'}</td></tr>
            <tr><th>Auto-send</th><td>{o.autoSend === null ? '—' : o.autoSend ? 'on' : 'off'}</td></tr>
            {o.openerRule ? <tr><th>Opener rule</th><td>{o.openerRule}</td></tr> : null}
            {o.other.map(([k, text]) => (
              <tr key={k}><th className="mono">{k}</th><td>{text}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">This profile says nothing about outreach.</p>
      )}
      {o?.note ? <p className="muted" style={{ fontSize: 13 }}>{o.note}</p> : null}

      {v.firmographics.length > 0 ? (
        <>
          <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>Firmographics</h3>
          <table>
            <tbody>
              {v.firmographics.map(([k, text]) => (
                <tr key={k}><th className="mono" style={{ width: 200 }}>{k}</th><td>{text}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Descriptive: the scanner reads public pages, and nothing in scanning or scoring reads these.
          </p>
        </>
      ) : null}
    </>
  )
}
