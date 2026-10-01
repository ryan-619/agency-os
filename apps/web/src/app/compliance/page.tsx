import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import {
  complianceSummary, type AgencyDb, type ComplianceOptOutFailureAction, type ComplianceSummary, type ComplianceUnsentStatus,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { readIcp } from '@/lib/company-list'
import { getDb } from '@/lib/db'
import { deployment, type Deployment } from '@/lib/deployment'
import { icpForOrg } from '@/lib/queries'
import { refusalWords } from '@/lib/refusal-words'
import { workerStatus, type WorkerStatus } from '@/lib/worker-status'
import { recorders, workerBanner, type Absent } from './recorders'

/**
 * Compliance (§2.1, §2.2): the questions an auditor asks, as numbers
 * somebody can check.
 *
 * Every number is `complianceSummary()`'s — the same read the
 * `get_compliance_summary` tool makes, so the page and the agent cannot
 * disagree. Nothing here writes, and nothing here re-derives a rule the send
 * path already applied: quiet hours are NOT recomputed (today's window in
 * today's zone against yesterday's send is not an observation), and an
 * approval decided after its expiry is shown as the clean expiry
 * `decideApproval` makes it, not as a breach.
 *
 * §2.2 applied to the auditor's own numbers: a zero only means something if
 * something on this deployment could have recorded a row. So each block
 * names its recorder and says when that recorder is absent — "none
 * recorded", never "none happened". Whether a worker records is read from
 * its heartbeat, not from `deployment()` (`./recorders.ts`): a worker on Fly
 * sends against this database whether or not this web half holds its URL.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** The most rows any one table renders; the count above it is always whole. */
const ROWS = 50

const SUPPRESSION_SOURCE_WORDS: Readonly<Record<string, string>> = {
  manual: 'added on the suppressions page',
  reply: 'a reply that said stop',
  voice: 'asked on a call',
  unsubscribe: 'the one-click unsubscribe link',
  erasure: 'kept through an erasure',
  unrecorded: 'recorded before sources were tracked',
}

const CONSENT_SOURCE_WORDS: Readonly<Record<string, string>> = {
  booking_page: 'the public booking page',
  contacts_page: 'a person, on the contacts page',
  other: 'anything else (an import, a seed, an older writer)',
}

/** Which writer knew an opt-out failed to store. Typed by the list the digest counts, so a new one fails the build. */
const OPT_OUT_FAILURE_PATH: Readonly<Record<ComplianceOptOutFailureAction, string>> = {
  'contact.opt_out_not_recorded': 'a reply or a call',
  'unsubscribe.not_recorded': 'the one-click unsubscribe link',
  'contact.erasure_failed': 'an erasure',
}

const UNSENT_STATUS_WORDS: Readonly<Record<ComplianceUnsentStatus, string>> = {
  awaiting_approval: 'awaiting approval',
  approved: 'approved, waiting for its moment',
  queued: 'queued to send automatically',
  sending: 'being sent',
}

const EVIDENCE_WORDS: Readonly<Record<string, string>> = {
  never_scanned: 'never scanned',
  unreachable: 'last scan could not reach the site',
  stale: 'stale',
}

export default async function CompliancePage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  // The dashboard's guarded read: `isStale` throws on a threshold that is not
  // a positive number, and `parseIcpDefinition` does not check it, so an ICP
  // with `stale_after_days: 0` made this page a 500 while the dashboard beside
  // it fell back to the default. Both now fall back, and this page says so.
  const { unreadable, staleAfterDays: staleDays } = readIcp((await icpForOrg(user.orgId))?.definition)
  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  if (!can(principal, 'audit:read')) {
    return (
      <Shell user={user} current="compliance" signOut={signOutAction}>
        <h1>Compliance</h1>
        <div className="note">Your role cannot read the audit counts.</div>
      </Shell>
    )
  }

  const db = getDb() as unknown as AgencyDb
  const live = deployment()
  const now = new Date()
  const s = await complianceSummary(db, user.orgId, { staleDays, now })
  // The observation. Null when it cannot be read — most often because 0018,
  // which creates the table, is not applied — and the sentences then fall
  // back to what is configured, worded as configuration.
  let worker: WorkerStatus | null = null
  try {
    worker = await workerStatus(db, now)
  } catch {
    worker = null
  }
  const absent = recorders(live, worker)
  const banner = workerBanner(live, worker)

  return (
    <Shell user={user} current="compliance" signOut={signOutAction}>
      <h1>Compliance</h1>
      <p className="lede">
        Every number here is a count of rows, and every count links to its rows. A zero is &apos;none
        recorded&apos;, and the page says which recorder is absent on this deployment.
      </p>

      {unreadable ? (
        <div className="note note-warn" style={{ marginBottom: 8 }}>
          <strong>The active ICP could not be read.</strong> &quot;Stale&quot; below uses the default of{' '}
          {staleDays} days until the profile is fixed.
        </div>
      ) : null}

      {banner ? (
        <div className="note note-warn" style={{ marginBottom: 8 }}>
          <strong>{banner.lead}</strong> {banner.rest}
        </div>
      ) : null}

      <Disclosure s={s} absent={absent} />
      <OptOuts s={s} absent={absent} />
      <ColdOptIn s={s} absent={absent} />
      <DraftsOnStale s={s} />
      <Consents s={s} />
      <Suppressions s={s} absent={absent} />
      <Refusals s={s} absent={absent} />
      <Freshness s={s} live={live} />
      <LateApprovals s={s} absent={absent} />
      <AutoSend s={s} />

      <h2>What this page deliberately does not count</h2>
      <div className="note">
        <ul>
          <li>
            <strong>Quiet-hours breaches.</strong> Checking yesterday&apos;s send against today&apos;s window
            and today&apos;s timezone on the contact is not an observation — either may have changed since.
            The send path decided at the moment of sending, and a message it held back is counted under
            refusals as <code>quiet_hours</code>.
          </li>
          <li>
            <strong>What a consent said last month.</strong> The ledger keeps each person&apos;s current
            answer per channel. The checks above are against today&apos;s rows and say so.
          </li>
        </ul>
      </div>
    </Shell>
  )
}

// Who records what, on THIS deployment: `./recorders.ts`, from the heartbeat.

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Count({ n, label, href, mustBeZero }: { n: number; label: string; href?: string; mustBeZero?: boolean }) {
  const body = (
    <>
      <div className="n" style={mustBeZero && n > 0 ? { color: 'var(--warn)' } : undefined}>{n}</div>
      <div className="k">{label}</div>
    </>
  )
  return href ? <a className="card" href={href}>{body}</a> : <div className="card">{body}</div>
}

function Rule({ children }: { children: React.ReactNode }) {
  return <p className="muted" style={{ margin: '0 0 12px', fontSize: 13.5 }}>{children}</p>
}

function NoneRecorded({ why }: { why: readonly (string | null)[] }) {
  const reasons = why.filter((w): w is string => Boolean(w))
  return (
    <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
      None recorded.{reasons.length > 0 ? ` ${reasons.join(' ')}` : ''}
    </p>
  )
}

function Shown({ shown, total }: { shown: number; total: number }) {
  return total > shown ? (
    <p className="muted" style={{ fontSize: 12.5 }}>Showing the newest {shown} of {total}.</p>
  ) : null
}

function CompanyLink({ domain }: { domain: string | null }) {
  return domain ? (
    <a href={`/companies/${encodeURIComponent(domain)}`}>{domain}</a>
  ) : (
    <span className="muted">no company on file</span>
  )
}

function At({ at }: { at: Date | null }) {
  return at ? <When iso={at.toISOString()} /> : <span className="muted">—</span>
}

// ---------------------------------------------------------------------------
// The blocks, most serious first
// ---------------------------------------------------------------------------

function Disclosure({ s, absent }: { s: ComplianceSummary; absent: Absent }) {
  const d = s.disclosure
  return (
    <section>
      <h2>Calls where the AI did not say it was an AI</h2>
      <Rule>
        §2.1: the AI says it is an AI before anything else. An answered inbound call with no{' '}
        <code>disclosed_ai_at</code> did not — <code>callsThatDidNotDisclose()</code>. Must be zero.
      </Rule>
      <div className="cards">
        <Count n={d.undisclosed.length} label="answered, no disclosure recorded" href="#disclosure-rows" mustBeZero />
        <Count n={d.answeredInbound} label="answered inbound calls" href="/calls" />
        <Count n={d.calls} label="calls on record" href="/calls" />
      </div>
      {d.undisclosed.length > 0 ? (
        <table id="disclosure-rows" style={{ marginTop: 12 }}>
          <thead><tr><th>Started</th><th>Answered</th><th>Outcome</th><th></th></tr></thead>
          <tbody>
            {d.undisclosed.slice(0, ROWS).map((c) => (
              <tr key={c.id}>
                <td className="mono"><At at={c.startedAt} /></td>
                <td className="mono"><At at={c.answeredAt} /></td>
                <td>{(c.outcome ?? c.status).replace(/_/g, ' ')}</td>
                <td><a href={`/calls/${c.id}`}>the call</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoneRecorded why={[d.calls === 0 ? `No calls are on record at all. ${absent.voice}` : null]} />
      )}
    </section>
  )
}

function OptOuts({ s, absent }: { s: ComplianceSummary; absent: Absent }) {
  const w = s.optOuts.withoutSuppression
  const nr = s.optOuts.notRecorded
  return (
    <section>
      <h2>Opt-outs that are not on the suppression list</h2>
      <Rule>
        §2.1: an opt-out that failed to store must fail loudly to a person, never fall through. Every reply
        classed <code>opted_out</code> and every call with <code>opted_out_at</code>, checked against
        today&apos;s suppression list with the send path&apos;s own keys (an address matches itself and its
        domain). Must be zero. An address that cannot be read is listed, never treated as clear.
      </Rule>
      <div className="cards">
        <Count n={w.count} label="opted out, no matching suppression today" href="#opt-out-rows" mustBeZero />
        <Count n={nr.lastWindow.count} label={`opt-outs a writer could not store, last ${s.windowDays} days`} href="#not-recorded-rows" mustBeZero />
        <Count n={nr.allTime} label="…all time (history — stays after a fix)" href="/audit" />
      </div>
      {w.count > 0 ? (
        <table id="opt-out-rows" style={{ marginTop: 12 }}>
          <thead><tr><th>When</th><th>How</th><th>Company</th><th>Why it matches nothing</th></tr></thead>
          <tbody>
            {w.rows.slice(0, ROWS).map((r) => (
              <tr key={`${r.kind}-${r.id}`}>
                <td className="mono"><At at={r.at} /></td>
                <td>
                  {r.kind === 'call' ? <a href={`/calls/${r.id}`}>a call</a> : `a ${r.channel} reply`}
                </td>
                <td><CompanyLink domain={r.companyDomain} /></td>
                <td>
                  {r.why === 'unreadable'
                    ? 'the address or number cannot be read, so no row could ever match it'
                    : 'no suppression row matches it'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoneRecorded why={[absent.replies]} />
      )}
      <Shown shown={Math.min(ROWS, w.rows.length)} total={w.count} />
      {nr.lastWindow.count > 0 ? (
        <table id="not-recorded-rows" style={{ marginTop: 12 }}>
          <thead><tr><th>When</th><th>Path</th><th>Channel</th><th>Company</th><th>Reason class</th></tr></thead>
          <tbody>
            {nr.lastWindow.rows.slice(0, ROWS).map((r) => (
              <tr key={r.auditId}>
                <td className="mono"><At at={r.at} /></td>
                <td>{OPT_OUT_FAILURE_PATH[r.action]}</td>
                <td>{r.channel ?? '—'}</td>
                <td><CompanyLink domain={r.companyDomain} /></td>
                <td className="mono">{r.why ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Shown shown={Math.min(ROWS, nr.lastWindow.rows.length)} total={nr.lastWindow.count} />
    </section>
  )
}

function ColdOptIn({ s, absent }: { s: ComplianceSummary; absent: Absent }) {
  const c = s.coldOptIn
  return (
    <section>
      <h2>Voice, SMS and WhatsApp that went out without an opt-in</h2>
      <Rule>
        §2.1: cold outreach is email and LinkedIn only; voice, SMS and WhatsApp need a recorded opt-in.
        Messages on those channels that went out (sent, delivered, bounced or replied to) to a contact with
        no <code>granted</code> consent row for that channel today. Must be zero. A message the send path
        refused is the rule working, and is counted apart.
      </Rule>
      <div className="cards">
        <Count n={c.contacts} label="contacts with such a message" href="#cold-rows" mustBeZero />
        <Count n={c.touches} label="messages, incl. erased contacts" href="#cold-rows" mustBeZero />
        <Count n={c.stoppedBySendPath} label="stopped by the send path (the gate working)" href="#stopped-rows" />
      </div>
      {c.touches > 0 ? (
        <table id="cold-rows" style={{ marginTop: 12 }}>
          <thead><tr><th>Sent</th><th>Channel</th><th>Company</th><th>Consent today</th></tr></thead>
          <tbody>
            {c.rows.slice(0, ROWS).map((r) => (
              <tr key={r.touchId}>
                <td className="mono"><At at={r.sentAt} /></td>
                <td>{r.channel}</td>
                <td><CompanyLink domain={r.companyDomain} /></td>
                <td>
                  {r.consentNow === 'contact_erased' ? (
                    'the contact was erased, and their consent rows with them — cannot be checked'
                  ) : r.consentNow === 'refused' ? (
                    <>refused, recorded <At at={r.consentRecordedAt} /> — after the send, if later than it</>
                  ) : (
                    'never asked'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoneRecorded why={[absent.sending]} />
      )}
      <Shown shown={Math.min(ROWS, c.rows.length)} total={c.touches} />
      {c.stoppedBySendPath > 0 ? (
        <details id="stopped-rows" style={{ marginTop: 10 }}>
          <summary>The newest {c.stoppedRows.length} of {c.stoppedBySendPath} the send path stopped</summary>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Refused</th><th>Rule</th><th>Channel</th><th>Company</th></tr></thead>
            <tbody>
              {c.stoppedRows.map((x) => (
                <tr key={x.touchId}>
                  <td className="mono"><At at={x.at} /></td>
                  <td>{refusalWords(x.code)}</td>
                  <td>{x.channel}</td>
                  <td><CompanyLink domain={x.companyDomain} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  )
}

function DraftsOnStale({ s }: { s: ComplianceSummary }) {
  const d = s.draftsOnStaleEvidence
  return (
    <section>
      <h2>Messages waiting to go on stale or missing evidence</h2>
      <Rule>
        §2.2: findings older than {s.freshness.staleDays} days must be re-verified before they appear in any
        outbound draft. Every outbound message not yet sent — awaiting approval, approved and waiting for its
        moment, queued to send automatically, or being sent — whose company has no successful scan, whose
        last one is stale, or whose words were written from a scan that has gone stale since or that a newer
        successful scan has superseded, measured from the scan&apos;s <code>ran_at</code>. The send path refuses
        a message at sending when the scan its words were written from is stale (<code>stale_evidence</code>),
        whoever approved it, and when a newer successful scan has superseded it: those are waiting to be
        refused, or to be denied and drafted again from the latest scan. It does not judge by evidence a message
        with no successful scan behind it, or an answer to a reply — those go as written unless another rule
        stops them, and only the ones awaiting approval wait on a person. Should be zero; an answer is listed
        too, tagged, because nothing marks which of its words came from the scan.
      </Rule>
      <div className="cards">
        <Count n={d.count} label="on stale or missing evidence" href="#draft-rows" mustBeZero />
        <Count n={d.refusedAtSending} label="…of which refused at sending (stale or superseded evidence) — draft again from a current scan" href="#draft-rows" />
        <Count n={d.notJudgedAtSending} label="…of which not judged by evidence (no successful scan behind the words, or an answer to a reply)" href="#draft-rows" />
        <Count n={d.notJudgedNoFurtherLook} label="…of those, go with nobody looking again (approved, queued, sending)" href="#draft-rows" />
        <Count n={d.unsent} label="outbound messages not yet sent" href="/approvals" />
      </div>
      {d.count > 0 ? (
        <table id="draft-rows" style={{ marginTop: 12 }}>
          <thead><tr><th>Drafted</th><th>Company</th><th>Status</th><th>Evidence</th><th>At sending</th><th></th></tr></thead>
          <tbody>
            {d.rows.slice(0, ROWS).map((r) => (
              <tr key={r.touchId}>
                <td className="mono"><At at={r.createdAt} /></td>
                <td><CompanyLink domain={r.domain} /></td>
                <td>{UNSENT_STATUS_WORDS[r.status]}</td>
                <td>
                  {r.why === 'no_evidence' ? (
                    'no successful scan'
                  ) : r.why === 'rescanned_since' ? (
                    <>written from the scan of <At at={r.writtenFromScanAt} />; re-scanned <At at={r.lastOkScanAt} /> since</>
                  ) : r.why === 'superseded' ? (
                    <>written from the scan of <At at={r.writtenFromScanAt} />, still fresh; superseded by the newer scan of <At at={r.lastOkScanAt} /></>
                  ) : (
                    <>last good scan <At at={r.lastOkScanAt} /></>
                  )}
                  {r.answersReply ? <span className="pill" style={{ marginLeft: 6 }}>answer to a reply</span> : null}
                </td>
                <td>{r.refusedAtSending ? 'refused — stale evidence' : 'not judged by evidence'}</td>
                <td>{r.status === 'awaiting_approval' ? <a href="/approvals">approvals</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoneRecorded why={[]} />
      )}
      <Shown shown={Math.min(ROWS, d.rows.length)} total={d.count} />
    </section>
  )
}

function Consents({ s }: { s: ComplianceSummary }) {
  const c = s.consents
  return (
    <section>
      <h2>Consent on record</h2>
      <Rule>
        §2.1: consent is per channel, and absence means no. One row per person per channel; a refusal is
        final against a later grant. Where a row came from is read off what its writer stamps.
      </Rule>
      <div className="cards">
        <Count n={c.total.granted} label="granted" href="/contacts" />
        <Count n={c.total.refused} label="refused — never asked again" href="/contacts" />
      </div>
      <div className="two-up" style={{ marginTop: 12 }}>
        <table>
          <thead><tr><th>Channel</th><th style={{ textAlign: 'right' }}>Granted</th><th style={{ textAlign: 'right' }}>Refused</th></tr></thead>
          <tbody>
            {c.byChannel.map((r) => (
              <tr key={r.channel}>
                <td>{r.channel}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{r.granted}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{r.refused}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <thead><tr><th>Recorded by</th><th style={{ textAlign: 'right' }}>Granted</th><th style={{ textAlign: 'right' }}>Refused</th></tr></thead>
          <tbody>
            {c.bySource.map((r) => (
              <tr key={r.source}>
                <td>{CONSENT_SOURCE_WORDS[r.source] ?? r.source}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{r.granted}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{r.refused}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Every person and their consent per channel is on the <a href="/contacts">contacts page</a>.
      </p>
    </section>
  )
}

function Suppressions({ s, absent }: { s: ComplianceSummary; absent: Absent }) {
  const recent = new Map(s.suppressions.lastWindow.bySource.map((r) => [r.source, r.n]))
  const whyNot: Readonly<Record<string, string | null>> = {
    reply: absent.replies,
    unsubscribe: absent.unsubscribe,
    voice: absent.voice,
  }
  return (
    <section>
      <h2>Suppressions, by how they were recorded</h2>
      <Rule>
        §2.1: a suppression wins over everything and is checked first on every message. Which path wrote
        each row is a column (0018), not a guess from its reason.
      </Rule>
      <div className="cards">
        <Count n={s.suppressions.lastWindow.total} label={`added, last ${s.windowDays} days`} href="/suppressions" />
        <Count n={s.suppressions.allTime.total} label="on the list, all time" href="/suppressions" />
      </div>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Source</th>
            <th style={{ textAlign: 'right' }}>Last {s.windowDays} days</th>
            <th style={{ textAlign: 'right' }}>All time</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {s.suppressions.allTime.bySource.map((r) => (
            <tr key={r.source}>
              <td><span className="tag">{r.source}</span> <span className="muted">{SUPPRESSION_SOURCE_WORDS[r.source] ?? ''}</span></td>
              <td className="mono" style={{ textAlign: 'right' }}>{recent.get(r.source) ?? 0}</td>
              <td className="mono" style={{ textAlign: 'right' }}>{r.n}</td>
              <td className="muted" style={{ fontSize: 12.5 }}>{r.n === 0 ? whyNot[r.source] ?? null : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Refusals({ s, absent }: { s: ComplianceSummary; absent: Absent }) {
  const r = s.refusals
  return (
    <section>
      <h2>Refusals in the last {s.windowDays} days</h2>
      <Rule>
        Every message the send path would not send, by the rule that stopped it — the system working, not
        something going wrong. Split by whether a person could resolve it by deciding (a timezone, a cap, a
        draft) or not at all (an opt-out, a refusal, a cold channel).
      </Rule>
      <div className="cards">
        <Count n={r.total} label="refused" href="#refusal-rows" />
        <Count n={r.humanCanResolve} label="a person could resolve" href="#refusal-rows" />
        <Count n={r.noOneCanOverride} label="nobody may approve past" href="#refusal-rows" />
        {r.unknownCode > 0 ? <Count n={r.unknownCode} label="a code this revision does not know" href="#refusal-rows" /> : null}
      </div>
      {r.total > 0 ? (
        <>
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Rule</th><th style={{ textAlign: 'right' }}>Refused</th><th>Can a person resolve it?</th></tr></thead>
            <tbody>
              {r.byCode.map((c) => (
                <tr key={c.code}>
                  <td>{refusalWords(c.code)} <code>{c.code}</code></td>
                  <td className="mono" style={{ textAlign: 'right' }}>{c.n}</td>
                  <td>{c.humanCanResolve === null ? 'unknown code' : c.humanCanResolve ? 'yes' : 'no — never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details id="refusal-rows" style={{ marginTop: 10 }}>
            <summary>The newest {r.recent.length} of {r.total}</summary>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Refused</th><th>Rule</th><th>Channel</th><th>Company</th></tr></thead>
              <tbody>
                {r.recent.map((x) => (
                  <tr key={x.touchId}>
                    <td className="mono"><At at={x.at} /></td>
                    <td>{refusalWords(x.code)}</td>
                    <td>{x.channel}</td>
                    <td><CompanyLink domain={x.companyDomain} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <NoneRecorded
          why={[
            absent.sending
              ? `${absent.sending} The send path runs in the worker; the only refusals written here are drafts a person denied${absent.replies ? '' : ' and messages cancelled by a reply'}.`
              : null,
          ]}
        />
      )}
    </section>
  )
}

function Freshness({ s, live }: { s: ComplianceSummary; live: Deployment }) {
  const f = s.freshness
  return (
    <section>
      <h2>Evidence freshness</h2>
      <Rule>
        §2.2: the app must never state a finding it did not observe, and an observation older than{' '}
        {f.staleDays} days (the ICP&apos;s threshold) must be re-verified. Each company&apos;s latest scan,
        aged from its <code>ran_at</code> — never from <code>findings.stale</code>, which is a cache.
      </Rule>
      <div className="cards">
        <Count n={f.fresh} label="fresh" href="/companies" />
        <Count n={f.stale} label="stale" href="#freshness-rows" />
        <Count n={f.unreachable} label="unreachable at last scan" href="#freshness-rows" />
        <Count n={f.neverScanned} label="never scanned" href="#freshness-rows" />
      </div>
      {f.staleColumnSaysFresh > 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          {f.staleColumnSaysFresh} stale {f.staleColumnSaysFresh === 1 ? 'company still has' : 'companies still have'}{' '}
          findings the <code>findings.stale</code> column calls fresh — the column is only rewritten when a
          scan runs. The count above is the derived one.
        </p>
      ) : null}
      {live.cron ? null : (
        <p className="muted" style={{ fontSize: 13 }}>
          No cron secret is configured, so nothing re-scans on a schedule here: evidence ages until somebody
          runs a scan.
        </p>
      )}
      {f.notFresh.length > 0 ? (
        <details id="freshness-rows" style={{ marginTop: 10 }}>
          <summary>The {f.notFresh.length} companies that are not fresh</summary>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Company</th><th>Evidence</th><th>Latest scan</th></tr></thead>
            <tbody>
              {f.notFresh.map((c) => (
                <tr key={c.companyId}>
                  <td><CompanyLink domain={c.domain} /></td>
                  <td>{EVIDENCE_WORDS[c.state] ?? c.state}</td>
                  <td className="mono"><At at={c.lastScanAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  )
}

function LateApprovals({ s, absent }: { s: ComplianceSummary; absent: Absent }) {
  const a = s.lateApprovals
  return (
    <section>
      <h2>Approvals decided after expiry</h2>
      <Rule>
        §2.4: a decision on a lapsed request comes back as a clean <code>expired</code> from the decision
        path, so this is not a breach. Decided rows whose <code>decided_at</code> is past their{' '}
        <code>expires_at</code>, shown for completeness.
      </Rule>
      <div className="cards">
        <Count n={a.count} label="decided after expiry — a clean expiry, informational, against today's rows" href="#late-approval-rows" />
      </div>
      {a.count > 0 ? (
        <table id="late-approval-rows" style={{ marginTop: 12 }}>
          <thead><tr><th>Tool</th><th>Decision</th><th>Expired</th><th>Decided</th></tr></thead>
          <tbody>
            {a.rows.slice(0, ROWS).map((r) => (
              <tr key={r.id}>
                <td><code>{r.toolName}</code></td>
                <td>{r.status}</td>
                <td className="mono"><At at={r.expiresAt} /></td>
                <td className="mono"><At at={r.decidedAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoneRecorded why={[absent.agent]} />
      )}
      <Shown shown={Math.min(ROWS, a.rows.length)} total={a.count} />
    </section>
  )
}

function AutoSend({ s }: { s: ComplianceSummary }) {
  const a = s.autoSendOffCold
  return (
    <section>
      <h2>Auto-send on a channel other than email or LinkedIn</h2>
      <Rule>
        §2.1 and §2.4: only the cold channels may send without a person, and the database refuses anything
        else (<code>{a.constraint}</code>). &quot;Impossible&quot; is a claim, so this is the check, as it ran:
      </Rule>
      <p style={{ margin: '0 0 12px' }}>
        <code>SELECT … FROM campaigns WHERE org_id = $1 AND {a.where}</code>
      </p>
      <div className="cards">
        <Count n={a.count} label="campaigns found" href="/campaigns" mustBeZero />
      </div>
      {a.count > 0 ? (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Campaign</th><th>Channel</th></tr></thead>
          <tbody>
            {a.rows.map((r) => (
              <tr key={r.id}><td><a href="/campaigns">{r.name}</a></td><td>{r.channel}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoneRecorded why={['The CHECK makes a row that would match unstorable.']} />
      )}
    </section>
  )
}
