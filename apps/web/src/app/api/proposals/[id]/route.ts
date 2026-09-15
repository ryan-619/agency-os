import { NextResponse } from 'next/server'
import { assertCan } from '@agency/core'
import { readProposal, setProposalStatus, type AgencyDb, type ProposalStatus } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'

/**
 * Record what happened to a proposal (PROMPT.md §8.6).
 *
 * `sent` records that a person sent it — the sending itself is not done
 * here, or anywhere but the send path (§8.4). `accepted` closes the deal as
 * won; `declined` and `withdrawn` are the other two ways it ends. A decided
 * proposal is not reopened by this route: a buyer who accepted and then did
 * not sign is a new proposal, and its history stays legible.
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

  const row = await setProposalStatus(db, { orgId: user.orgId, id, status: to, actor: user.id })
  if (!row) return NextResponse.json({ error: 'No such proposal.' }, { status: 404 })
  return NextResponse.json({ id, status: row.status, decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null })
}
