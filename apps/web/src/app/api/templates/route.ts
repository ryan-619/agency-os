import { NextResponse } from 'next/server'
import { templatesList, type AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { templateCreateAnswer } from './outcome'
import {
  TEMPLATE_MAX_REQUEST_BYTES, firstIssue, mayReadTemplates, mayWriteTemplates, templateCreateSchema, templateView,
} from './rules'

/**
 * The org's registered message templates (0019).
 *
 * GET lists them — `?channel=sms` for one channel, `?active=1` for the ones
 * a message can be drafted from, which is what the SMS composer asks for.
 * POST records one, as the DLT portal registered it; `templatesCreate`
 * refuses, with a sentence, anything that would not store or that this org
 * already holds under that id; a database fault under it is a 500 with a
 * sentence and a log line naming its class, never drizzle's message
 * (`templateCreateAnswer`, `./outcome.ts`). Nothing here registers a
 * template with an operator, and nothing here sends: an SMS drafted from a
 * template is approved by a person and checked again at sending.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayReadTemplates({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const params = new URL(request.url).searchParams
  const channelParam = params.get('channel')
  const channel = channelParam === 'sms' || channelParam === 'whatsapp' || channelParam === 'voice' ? channelParam : undefined
  const rows = await templatesList(getDb() as unknown as AgencyDb, user.orgId, {
    ...(channel ? { channel } : {}),
    activeOnly: params.get('active') === '1',
  })
  return NextResponse.json({ templates: rows.map(templateView) })
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteTemplates({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const raw = await request.text()
  if (raw.length > TEMPLATE_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'That request is too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = templateCreateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 })

  const answer = await templateCreateAnswer(
    getDb() as unknown as AgencyDb,
    { orgId: user.orgId, input: parsed.data, createdBy: user.id },
    log,
  )
  return NextResponse.json(answer.body, { status: answer.status })
}
