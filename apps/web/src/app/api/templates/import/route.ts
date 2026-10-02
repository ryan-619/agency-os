import { NextResponse } from 'next/server'
import type { AgencyDb } from '@agency/db/queries'
import { auth } from '@/auth'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { templateImportAnswer } from '../outcome'
import { NOT_UTF8, TEMPLATE_IMPORT_MAX_BYTES, decodeUtf8, mayWriteTemplates } from '../rules'

/**
 * Import a DLT portal's template export as SMS templates (0019).
 *
 * The body is the file itself — the bytes of a CSV, uploaded or pasted —
 * read as strict UTF-8: Excel's plain "CSV" is Windows-1252, and a template
 * whose text came through a lossy decode would never match what the operator
 * scrubs it against. Over a megabyte is a 413 before anything is read.
 *
 * `templatesImportDltCsv` decides everything else and answers per line —
 * imported, already present, skipped (not approved on the portal, or a
 * repeat), or refused with the sentence that says why — so the page can
 * show the outcome of every line, and a re-import of the same file changes
 * nothing. A file it cannot read as a whole is a 400 with its sentence, and
 * a database fault part-way is a 500 saying that lines before it may be
 * recorded and a re-import is safe, with a log line naming the fault's class
 * only (`templateImportAnswer`, `../outcome.ts`; review round 9).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth()
  const user = session?.user
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!mayWriteTemplates({ id: user.id, orgId: user.orgId, role: user.role })) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const tooLarge = NextResponse.json(
    { error: `One import takes up to ${TEMPLATE_IMPORT_MAX_BYTES / 1_000_000} MB. Split the file and import each part.` },
    { status: 413 },
  )
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > TEMPLATE_IMPORT_MAX_BYTES) return tooLarge
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > TEMPLATE_IMPORT_MAX_BYTES) return tooLarge

  const text = decodeUtf8(bytes)
  if (text === null) return NextResponse.json({ error: NOT_UTF8 }, { status: 400 })
  if (!text.trim()) {
    return NextResponse.json({ error: 'Nothing to import — choose the export, or paste its rows header first.' }, { status: 400 })
  }

  const answer = await templateImportAnswer(getDb() as unknown as AgencyDb, { orgId: user.orgId, text, createdBy: user.id }, log)
  return NextResponse.json(answer.body, { status: answer.status })
}
