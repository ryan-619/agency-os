import { isNoSiteDomain } from '@agency/core'
import { presenceReport, shareLinksFor, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { ShareButtons } from './share-buttons'
import type { CompanySlotProps } from './slot'

/**
 * What the business can be shown (2026-10-08): its own audit page — what we
 * noticed, how it compares with its nearest competitors, what Google
 * measured — and, for one with no website of its own, a preview of the site
 * the agency would build. Each is a link a person sends: copied, or in an
 * email that waits on /approvals. The first time it is opened, whoever made
 * it gets a task to follow up.
 *
 * Before anybody sends one, it says what the audit page cannot say yet — the
 * sentences `needsOf` writes for the team, never shown to the business — and
 * whether any competitor of its kind is near enough to compare with.
 */
export async function ShareSlot(props: CompanySlotProps) {
  const db = getDb() as unknown as AgencyDb
  const [links, report] = await Promise.all([
    shareLinksFor(db, { orgId: props.orgId, companyId: props.companyId }),
    presenceReport(db, { orgId: props.orgId, companyId: props.companyId, now: new Date() }).catch(() => null),
  ])
  const shown = links.filter((l) => l.kind === 'report' || l.kind === 'preview')
  const gaps = report
    ? [
        ...report.notAssessed,
        ...(report.peers.length === 0
          ? [
              report.company.googleCategory
                ? 'No competitor of its kind near it is in the CRM with a current listing, so the page shows no comparison — find a few on the map in Chat.'
                : 'It has no Google listing on record, so the page compares it with nobody — find it on the map in Chat.',
            ]
          : []),
      ]
    : []
  return (
    <section className="card" style={{ marginTop: 18 }}>
      <h2 style={{ marginTop: 0 }}>Show the business</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        A page of its own, from public information: what we noticed, how it compares with nearby competitors and what Google
        measured{isNoSiteDomain(props.domain) ? ' — and, with no website of its own, a preview of the one you would build' : ''}.
        When they open it, you get a task to call while they are reading.
      </p>
      {gaps.length > 0 ? (
        <div className="hint" style={{ margin: '0 0 10px' }}>
          <strong>Before you send it — the audit page cannot say yet:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      ) : null}
      <ShareButtons companyId={props.companyId} canWrite={props.canWrite} preview={isNoSiteDomain(props.domain)} />
      {shown.length > 0 ? (
        <table style={{ marginTop: 10 }}>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id}>
                <td>{l.kind === 'report' ? 'Audit page' : 'Website preview'}</td>
                <td>made {l.createdAt.toISOString().slice(0, 10)}</td>
                <td>{l.revokedAt ? 'revoked' : l.expiresAt < new Date() ? 'expired' : `opens until ${l.expiresAt.toISOString().slice(0, 10)}`}</td>
                <td>{l.viewCount === 0 ? 'not opened yet' : `opened ${l.viewCount}× · last ${l.lastViewedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC`}</td>
                <td>{!l.revokedAt && props.canWrite ? <ShareButtons.Revoke companyId={props.companyId} linkId={l.id} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}
