import { redirect } from 'next/navigation'
import { DEFAULT_STALE_AFTER_DAYS, can, isStale, parseIcpDefinition, type IcpDefinition } from '@agency/core'
import { and, desc, eq } from 'drizzle-orm'
import {
  evidenceAsOfFor, listCampaigns, listContactsForCompany, pendingApprovals, pendingDrafts, previewSend, quotableFindings,
  readContact, schema, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { deployment, nothingWillSendNote } from '@/lib/deployment'
import { icpForOrg } from '@/lib/queries'
import {
  addressedByOf, campaignToCheck, decisionView, evidenceLine, uncheckedDecision,
  type CandidateDecision, type DraftEvidence,
} from '@/lib/approval-view'
import { ApprovalQueue } from '@/components/chat/queue'
import { DraftQueue, type DraftView } from '@/components/outreach/drafts'

/**
 * The approval queue (PROMPT.md §2.4, §5.4).
 *
 * The chat panel shows an approval inline, which is the right place when
 * someone is watching the turn that raised it. This page is for the other
 * case, which is at least as common: the person who asked has gone to lunch,
 * and the turn is parked for thirty minutes waiting on anybody at all.
 *
 * §5.4's `notifyTeam(approval)` is this page, the sidebar count, and the row
 * itself. It deliberately sends no mail: Phase 2 ships no send path, §8.4 says
 * there must be exactly one, and adding a second here — to notify about the
 * first — would be the joke writing itself.
 *
 * A draft card shows the same facts the sender reads, from the same function
 * (`previewSend`), and the evidence the draft may quote with its date. It
 * used to hand-roll "reachable" from the contact row — address, pause,
 * declined, zone — which is a second opinion about §2.1 that could only ever
 * disagree with the sender, and never knew about the suppression list at
 * all. Nothing here decides: the display is read-only and the check stays in
 * the send path, which runs again at the moment of sending.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * How many (person, campaign) previews one page load runs. Each is a handful
 * of indexed reads, and on Vercel the pool is ONE connection, so they queue.
 * The people a row came addressed to are previewed first; past the limit a
 * candidate says it was not checked here, which is true — the worker checks
 * every rule at sending regardless.
 */
const PREVIEW_LIMIT = 80
const PREVIEW_CONCURRENCY = 4

/** Run `fn` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(lanes)
  return out
}

/** The address a channel would use — `recipientFor` in the send path, restated for a label. */
function addressFor(channel: string, c: { email: string | null; phone: string | null; linkedinUrl: string | null }) {
  switch (channel) {
    case 'email':
      return c.email
    case 'linkedin':
      return c.linkedinUrl
    case 'sms':
    case 'voice':
    case 'whatsapp':
      return c.phone
    default:
      return null
  }
}

export default async function ApprovalsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user

  const db = getDb() as unknown as AgencyDb
  const now = new Date()
  const [rows, drafts, campaigns, icpRow] = await Promise.all([
    pendingApprovals(db, user.orgId),
    pendingDrafts(db, user.orgId),
    listCampaigns(db, user.orgId),
    icpForOrg(user.orgId),
  ])

  let icp: IcpDefinition | null = null
  try {
    icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  } catch {
    icp = null
  }
  const orgLabel = icp?.label ?? 'Agency'
  // `isStale` throws on a non-positive threshold, and one bad ICP value must
  // not take the approval queue down with it. The default is §2.2's own 14.
  const configured = icp?.freshness?.stale_after_days
  const staleAfter =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_AFTER_DAYS

  const campaignChoices = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    channel: c.channel,
    autoSend: c.autoSend,
    status: c.status,
  }))

  /**
   * Who each draft could go to: everyone at its company, and the person the
   * row came addressed to if they are not (an inbox answer to somebody with
   * no company). Nobody is silently omitted — a person the sender would
   * refuse is listed with the refusal, because "on the suppression list" is
   * something to know and an empty list is not.
   */
  const companyIds = [...new Set(drafts.map((d) => d.company?.id).filter((id): id is string => Boolean(id)))]
  const contactsByCompany = new Map(
    await Promise.all(
      companyIds.map(async (id) => [id, await listContactsForCompany(db, user.orgId, id)] as const),
    ),
  )
  const strayIds = [
    ...new Set(
      drafts
        .filter((d) => {
          const own = d.touch.contactId
          if (!own) return false
          const people = d.company ? contactsByCompany.get(d.company.id) ?? [] : []
          return !people.some((p) => p.id === own)
        })
        .map((d) => d.touch.contactId as string),
    ),
  ]
  const strays = new Map(
    (await Promise.all(strayIds.map((id) => readContact(db, user.orgId, id)))).flatMap((c) => (c ? [[c.id, c] as const] : [])),
  )

  const planned = drafts.map((d) => {
    const people = d.company ? contactsByCompany.get(d.company.id) ?? [] : []
    const own = d.touch.contactId ? strays.get(d.touch.contactId) : undefined
    return {
      d,
      people: own ? [...people, own] : people,
      checked: campaignToCheck({ channel: d.touch.channel, campaignId: d.touch.campaignId }, campaignChoices),
    }
  })

  /**
   * The previews, one per distinct (person, campaign, moment the words were
   * written): two drafts about one company written together share their
   * answers. The moment is part of the question since stale evidence is a
   * rule (§2.2): the sender judges a draft's words by the scan current when
   * they were WRITTEN, so a preview "as if written now" would call fresh a
   * draft the worker will refuse. An answer to a reply quotes no scan
   * (`evidenceAsOfFor`). The preselected people go first, so the limit never
   * costs the card the one person it was addressed to.
   */
  const key = (contactId: string, campaignId: string, writtenAt: Date | null) =>
    `${contactId}:${campaignId}:${writtenAt ? writtenAt.toISOString() : 'answer'}`
  const wanted: { contactId: string; campaignId: string; writtenAt: Date | null }[] = []
  const seen = new Set<string>()
  const want = (contactId: string, campaignId: string, writtenAt: Date | null) => {
    const k = key(contactId, campaignId, writtenAt)
    if (seen.has(k)) return
    seen.add(k)
    wanted.push({ contactId, campaignId, writtenAt })
  }
  for (const p of planned) {
    if (p.checked && p.d.touch.contactId) want(p.d.touch.contactId, p.checked.id, evidenceAsOfFor(p.d.touch))
  }
  for (const p of planned) if (p.checked) for (const c of p.people) want(c.id, p.checked.id, evidenceAsOfFor(p.d.touch))

  const previewed = await mapLimit(wanted.slice(0, PREVIEW_LIMIT), PREVIEW_CONCURRENCY, async (w) => {
    const k = key(w.contactId, w.campaignId, w.writtenAt)
    try {
      const preview = await previewSend(db, {
        orgId: user.orgId, contactId: w.contactId, campaignId: w.campaignId, now, writtenAt: w.writtenAt,
      })
      return [k, preview.ok ? decisionView(preview.decision) : uncheckedDecision(preview.message)] as const
    } catch (err) {
      // Named, never the driver's message (it can carry the DSN — §2.3).
      const name = err instanceof Error ? err.name : 'UnknownError'
      return [k, uncheckedDecision(`The check did not run (${name}).`)] as const
    }
  })
  const decisions = new Map<string, CandidateDecision>(previewed)
  const notChecked = uncheckedDecision(
    `Not checked on this page: more people are waiting than one page load previews (${PREVIEW_LIMIT}). ` +
      'The worker checks every rule at sending regardless.',
  )

  /**
   * The evidence each company's drafts may quote, dated by the scan it came
   * from. `quotableFindings` is the draft generator's own filter — observed,
   * a gap, scored, the latest SUCCESSFUL scan, fresh by `isStale` on its
   * `ran_at` — so a line shown here is a line a draft may say, and nothing a
   * draft may not. A stale scan quotes nothing, and the card says so.
   */
  const evidenceByCompany = new Map<string, DraftEvidence | null>(
    await Promise.all(
      companyIds.map(async (companyId) => {
        const latest = await db
          .select({ id: schema.scans.id, ranAt: schema.scans.ranAt })
          .from(schema.scans)
          .where(and(eq(schema.scans.orgId, user.orgId), eq(schema.scans.companyId, companyId), eq(schema.scans.ok, true)))
          .orderBy(desc(schema.scans.ranAt))
          .limit(1)
        const scan = latest[0]
        if (!scan) return [companyId, null] as const
        if (isStale(scan.ranAt, staleAfter, now)) {
          return [companyId, { asOf: scan.ranAt.toISOString(), stale: true, lines: [] }] as const
        }
        const found = await quotableFindings(db, user.orgId, companyId, staleAfter, now)
        // `quotableFindings` reads "latest" again; if a scan landed between the
        // two reads, the lines are that scan's, so they carry its date.
        let asOf = scan.ranAt
        const first = found[0]
        if (first && first.scanId !== scan.id) {
          const newer = await db
            .select({ ranAt: schema.scans.ranAt })
            .from(schema.scans)
            .where(and(eq(schema.scans.orgId, user.orgId), eq(schema.scans.id, first.scanId)))
            .limit(1)
          asOf = newer[0]?.ranAt ?? asOf
        }
        const lines = found.map((f) =>
          evidenceLine({ signalKey: f.signalKey, why: icp?.signals[f.signalKey]?.why ?? null, detail: f.detail }),
        )
        return [companyId, { asOf: asOf.toISOString(), stale: false, lines }] as const
      }),
    ),
  )

  const draftViews: DraftView[] = planned.map(({ d, people, checked }) => {
    // Preselect only what the selects can show: a campaign on the draft's
    // channel that still exists, and a person in the list. A value with no
    // matching option would sit in state, invisible, behind an enabled Approve.
    const campaignId =
      d.touch.campaignId && campaignChoices.some((c) => c.id === d.touch.campaignId && c.channel === d.touch.channel)
        ? d.touch.campaignId
        : null
    const contactId = d.touch.contactId && people.some((p) => p.id === d.touch.contactId) ? d.touch.contactId : null
    return {
      id: d.touch.id,
      channel: d.touch.channel,
      subject: d.touch.subject,
      body: d.touch.body,
      createdAt: d.touch.createdAt.toISOString(),
      company: d.company,
      contactId,
      campaignId,
      addressedBy: addressedByOf({
        contactId: d.touch.contactId,
        campaignId: d.touch.campaignId,
        answersTouchId: d.touch.answersTouchId,
      }),
      checkedUnder: checked,
      candidates: people.map((c) => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'unnamed'
        const address = addressFor(d.touch.channel, c)
        return {
          id: c.id,
          label: address ? `${name} <${address}>` : `${name} (no ${d.touch.channel === 'linkedin' ? 'LinkedIn profile' : 'address'})`,
          decision: checked ? decisions.get(key(c.id, checked.id, evidenceAsOfFor(d.touch))) ?? notChecked : null,
        }
      }),
      evidence: d.company ? evidenceByCompany.get(d.company.id) ?? null : null,
    }
  })

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const decidable = can({ id: user.id, orgId: user.orgId, role: user.role }, 'approvals:decide')

  return (
    <Shell
      user={user}
      orgName={orgLabel}
      current="approvals"
      signOut={signOutAction}
      pendingApprovals={rows.length}
    >
      <h1>Approvals</h1>
      <p className="lede">
        Anything that would leave the building waits here for a person. Two kinds of thing arrive:
        a message the agent drafted, which you address and approve — the worker then sends it after
        checking every rule again — and a tool the agent is asking to use right now, which a
        conversation is parked on.
      </p>

      <h2 style={{ fontSize: 15, margin: '18px 0 8px' }}>Messages to approve</h2>
      {draftViews.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>No drafts are waiting.</p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
            Beside each person is what the send path would decide about them right now — the same check the
            worker runs, not a second opinion — and under each draft, the evidence it may quote and when it was
            observed. It is shown, not enforced here: every rule is checked again at the moment of sending.
          </p>
          <DraftQueue
            drafts={draftViews}
            campaigns={campaignChoices}
            canDecide={decidable}
            noSenderNote={nothingWillSendNote(deployment())}
          />
        </>
      )}

      <h2 style={{ fontSize: 15, margin: '22px 0 8px' }}>Tools waiting on you</h2>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No conversation is parked. When the agent tries to do something that leaves the building
          mid-conversation, it waits here for your answer.
        </p>
      ) : (
        <ApprovalQueue
          canDecide={decidable}
          items={rows.map((r) => ({
            id: r.id,
            toolName: r.toolName,
            risk: r.risk,
            // Not truncated. Someone deciding whether this may be sent has to
            // see exactly what they are approving.
            payload: r.payload,
            expiresAt: r.expiresAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
          }))}
        />
      )}

      {!decidable ? (
        <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
          Your role cannot decide approvals. Someone with the owner role has to.
        </p>
      ) : null}
    </Shell>
  )
}
