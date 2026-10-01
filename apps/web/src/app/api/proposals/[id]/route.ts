import { NextResponse, after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { assertCan } from '@agency/core'
import { readProposal, schema, setProposalStatus, type AgencyDb, type ProposalStatus } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { notify } from '@/lib/slack'
import { proposalAcceptedNotification } from './notification'

/**
 * Record what happened to a proposal (PROMPT.md §8.6).
 *
 * `sent` records that a person sent it — the sending itself is not done
 * here, or anywhere but the send path (§8.4). `accepted` closes the deal as
 * won; `declined` and `withdrawn` are the other two ways it ends. A decided
 * proposal is not reopened by this route: a buyer who accepted and then did
 * not sign is a new proposal, and its history stays legible.
 *
 * `accepted` also posts one Slack message when `SLACK_WEBHOOK_URL` is set,
 * from `after()`, once the person who pressed the button has their answer.
 * The company's domain is read inside that callback, so neither the read nor
 * the post can change the status of a decision already written.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const STATUSES: readonly ProposalStatus[] = ['draft', 'sent', 'accepted', 'declined', 'withdrawn']
const NEXT: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ['sent', 'withdrawn'],
  sent: ['accepted', 'declined', 'withdrawn'],
  accepted: [],
  declined: [],
  withdrawn: [],
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    assertCan({ id: user.id, orgId: user.orgId, role: user.role }, 'deals:write')
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await context.params
  const db = getDb() as unknown as AgencyDb
  const current = await readProposal(db, user.orgId, id)
  if (!current) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const { status } = (body ?? {}) as { status?: unknown }
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `status must be one of ${STATUSES.join(', ')}` }, { status: 400 })
  }
  const from = current.status as ProposalStatus
  const to = status as ProposalStatus
  if (!NEXT[from].includes(to)) {
    return NextResponse.json(
      { error: from === to ? `This proposal is already ${from}.` : `A ${from} proposal cannot become ${to}.` },
      { status: 409 },
    )
  }

  // `from` puts the status this request read into the UPDATE, so a buyer's
  // acceptance through their link that commits in between is not
  // overwritten. Review round 3, finding [12].
  const row = await setProposalStatus(db, { orgId: user.orgId, id, status: to, actor: user.id, from })
  if (!row) return notWritten(db, user.orgId, id, to)

  if (row.status === 'accepted') {
    const orgId = user.orgId
    try {
      after(async () => {
        try {
          const [company] = await db
            .select({ domain: schema.companies.domain })
            .from(schema.companies)
            .where(and(eq(schema.companies.orgId, orgId), eq(schema.companies.id, row.companyId)))
            .limit(1)
          if (!company) return
          const event = proposalAcceptedNotification({ orgId, row, companyDomain: company.domain })
          if (event) await notify(event)
        } catch (err) {
          // Caught here, not left to `after()`: Next prints an escaping
          // Error whole — message and cause — past the logger's redaction.
          log.warn('proposal_accepted notification failed', { error: err instanceof Error ? err.name : 'UnknownError' })
        }
      })
    } catch (err) {
      log.warn('proposal_accepted notification not scheduled', { error: err instanceof Error ? err.name : 'UnknownError' })
    }
  }

  return NextResponse.json({ id, status: row.status, decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null })
}

/**
 * Why `setProposalStatus` wrote nothing: the proposal is gone (404), or its
 * status is no longer the one this request read (409), and the person is
 * told what it became rather than that it does not exist.
 */
async function notWritten(db: AgencyDb, orgId: string, id: string, to: ProposalStatus): Promise<NextResponse> {
  const now = await readProposal(db, orgId, id)
  if (!now) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 })
  return NextResponse.json(
    {
      error:
        `This proposal became ${now.status} a moment ago — by a teammate, or by the buyer from their link — ` +
        `so it was not marked ${to}. Nothing was changed; reload to see it.`,
    },
    { status: 409 },
  )
}
