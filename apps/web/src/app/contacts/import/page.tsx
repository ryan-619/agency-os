import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { can } from '@agency/core'
import {
  CONTACT_IMPORT_COLUMNS, appendAudit, importContacts, parseContactSeeds, type AgencyDb, type ContactSeedRow,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'
import { ContactImportForm, type ContactImportState } from './import-form'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Cap one import so a mis-paste cannot try to import a novel. */
const MAX_ROWS = 5000

/**
 * Import people from a CSV (PROMPT.md §2.1, §8.4).
 *
 * Re-checks the session and the capability itself: a server action is an
 * endpoint anybody can post to, whatever the page that rendered it showed.
 * Writes one audit row carrying COUNTS — never an address, which is what the
 * report on the page is for.
 */
async function importAction(_prev: ContactImportState, formData: FormData): Promise<ContactImportState> {
  'use server'
  const s = await auth()
  if (!s?.user) redirect('/signin')
  const user = s.user
  if (!can({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:write')) {
    return { kind: 'error', message: 'Your role cannot add contacts.' }
  }

  const file = formData.get('file')
  const fromFile = file instanceof File && file.size > 0
  const text = fromFile ? await file.text() : String(formData.get('csv') ?? '')
  if (!text.trim()) return { kind: 'error', message: 'Nothing to import — choose a file or paste the rows.' }
  // `File.text()` decodes as UTF-8 and replaces what it cannot read with
  // U+FFFD. Excel's plain "CSV" is Windows-1252, so every accented name in it
  // would be stored with a replacement character where the letter was.
  if (fromFile && text.includes('�')) {
    return {
      kind: 'error',
      message:
        'That file is not UTF-8, so accented names in it would be stored garbled. Save it as "CSV UTF-8" ' +
        '(Excel lists it separately from plain CSV) and import again.',
    }
  }

  let rows: ContactSeedRow[]
  try {
    rows = parseContactSeeds(text)
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'That file could not be read.' }
  }
  if (rows.length === 0) return { kind: 'error', message: 'The file has a header and no rows under it.' }
  if (rows.length > MAX_ROWS) {
    return {
      kind: 'error',
      message: `That is ${rows.length.toLocaleString('en-GB')} rows; one import takes up to ${MAX_ROWS.toLocaleString('en-GB')}. Split the file.`,
    }
  }

  const db = getDb() as unknown as AgencyDb
  const result = await importContacts(db, user.orgId, rows, 'import')
  const counts = {
    inserted: result.inserted,
    alreadyPresent: result.alreadyPresent,
    unknownCompany: result.unknownCompany.length,
    refused: result.refused.length,
    phoneDropped: result.phoneDropped.length,
  }
  await appendAudit(db, {
    orgId: user.orgId,
    actor: user.id,
    action: 'contacts.imported',
    detail: counts,
  }).catch((err: unknown) => {
    log.error('contacts import audit row not written', { orgId: user.orgId, err: err instanceof Error ? err.name : 'unknown' })
  })
  log.info('contacts imported', { orgId: user.orgId, rows: rows.length, ...counts })
  revalidatePath('/contacts')
  return { kind: 'done', rows: rows.length, ...result }
}

export default async function ImportContacts() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const header = CONTACT_IMPORT_COLUMNS.join(',')

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="contacts" signOut={signOutAction}>
      <p className="crumb"><a href="/contacts">← Contacts</a></p>
      <h1>Import contacts</h1>

      <div className="note note-warn">
        <strong>
          Imported people start from NO on every channel. Nothing here records consent — that is done per person,
          per channel, with a source.
        </strong>
        <p style={{ margin: '8px 0 0' }}>
          Email and LinkedIn are the two cold channels and need no opt-in, so an imported person can be written to
          on those — through every rule the send path checks. SMS, voice and WhatsApp stay closed to them until
          somebody records an opt-in.
        </p>
      </div>

      <p className="lede">
        The first line names the columns, in any order: <code>{header}</code>. Every column must be named; any of
        them can be empty. Blank lines and lines starting with <code>#</code> are skipped, and a value with a comma
        in it goes in double quotes.
      </p>
      <ul className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        <li>
          Each row is matched to a company already here by its <code>domain</code>. A domain that matches none is
          listed and nobody at it is imported — <a href="/companies/import">import the companies</a> first.
        </li>
        <li>
          A <code>phone</code> must be international — a <code>+</code> and the country code. One that is not is left
          out and listed by line, never stored: no opt-out could ever be matched to it.
        </li>
        <li>
          A <code>time_zone</code> is an IANA name like <code>Europe/London</code>. A person without one uses their
          company&apos;s; with neither, nothing can be sent to them until one is declared.
        </li>
        <li>
          Somebody already here — the same email; without one, the same LinkedIn profile, or the same number and
          name at the same company — is reported as present and left alone, so importing a file twice adds nobody
          twice.
        </li>
      </ul>

      {can({ id: user.id, orgId: user.orgId, role: user.role }, 'contacts:write') ? (
        <ContactImportForm action={importAction} header={header} maxRows={MAX_ROWS} />
      ) : (
        <p className="muted">Your role cannot add contacts.</p>
      )}
    </Shell>
  )
}
