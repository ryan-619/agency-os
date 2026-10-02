import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import {
  consentLedgerFor, contactsLedger, listCampaigns, LEDGER_DEFAULT_LIMIT, type AgencyDb,
} from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { ContactsLedger, type LedgerView } from '@/components/contacts/ledger'
import { getDb } from '@/lib/db'
import { deployment, noRepliesReadNote } from '@/lib/deployment'
import {
  consentStateClass, consentStateLabel, suppressionClass, suppressionLabel, zoneLabel,
} from '@/lib/consent-view'

/**
 * Contacts — every person, and the per-channel truth about them (§2.1).
 *
 * The page reads what the sender reads. Each row's consent and suppression
 * answer comes from `consentLedgerFor`, the function the `get_consent` tool
 * reads, and "Why can't I reach them?" runs `previewSend`, the sender's own
 * dry run — so this page cannot say a person is reachable while the send path
 * refuses them. Never-asked, refused and granted are three different facts,
 * and each is shown as exactly one of them.
 *
 * Bounded to a hundred people a page: each row asks the suppression list its
 * own question, and a page that asked it ten thousand times would be the
 * slowest thing in the product.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = Record<string, string | string[] | undefined>

/**
 * The first value of a query-string key. Next hands a REPEATED key over as
 * an array, whatever the page's type says, so `?q=a&q=b` reached `.trim()`
 * as `['a', 'b']` and the page was a 500.
 */
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim()

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  if (!can(principal, 'contacts:read')) redirect('/')

  const params = await searchParams
  const q = one(params['q']).slice(0, 200)
  const pausedParam = one(params['paused'])
  const paused = pausedParam === 'yes' ? true : pausedParam === 'no' ? false : undefined
  const companyParam = one(params['company'])
  const companyId = UUID.test(companyParam) ? companyParam : undefined
  const page = Math.max(1, Math.min(1000, Number.parseInt(one(params['page']) || '1', 10) || 1))
  const limit = LEDGER_DEFAULT_LIMIT

  const db = getDb() as unknown as AgencyDb
  const [rows, campaigns] = await Promise.all([
    contactsLedger(db, user.orgId, { q: q || undefined, paused, companyId, limit, offset: (page - 1) * limit }),
    listCampaigns(db, user.orgId),
  ])
  // One ledger read per person on the page — at most `limit` of them.
  const ledgers = await Promise.all(rows.map((r) => consentLedgerFor(db, user.orgId, r.id)))

  const views: LedgerView[] = []
  rows.forEach((r, i) => {
    const ledger = ledgers[i]
    // Deleted between the two reads: not shown, rather than shown half-known.
    if (!ledger) return
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || '(no name recorded)'
    views.push({
      id: r.id,
      name,
      firstName: r.firstName,
      lastName: r.lastName,
      title: r.title,
      email: r.email,
      phone: r.phone,
      linkedinUrl: r.linkedinUrl,
      companyDomain: r.companyDomain,
      companyName: r.companyName,
      zone: zoneLabel(r.timeZone, r.companyTimeZone),
      zoneMissing: !r.timeZone && !r.companyTimeZone,
      pausedAt: r.pausedAt ? r.pausedAt.toISOString() : null,
      pausedReason: r.pausedReason,
      sharedNumberHold: ledger.sharedNumberHold,
      // The column exists from 0018 and nothing writes it yet; shown only when set.
      emailBouncedAt: r.emailBouncedAt ? r.emailBouncedAt.toISOString() : null,
      emailBounceCode: r.emailBounceCode,
      channels: ledger.channels.map((c) => ({
        channel: c.channel,
        state: c.state,
        label: consentStateLabel(c, c.channel),
        cls: consentStateClass(c, c.channel),
        source: c.source,
      })),
      suppression: (['email', 'phone', 'linkedin'] as const).map((key) => ({
        key,
        label: suppressionLabel(ledger.suppression[key]),
        cls: suppressionClass(ledger.suppression[key]),
      })),
      matches: ledger.suppression.matches.map((m) => ({ kind: m.kind, source: m.source })),
    })
  })

  const repliesNote = noRepliesReadNote(deployment())
  const pausedCount = views.filter((v) => v.pausedAt).length
  const hasMore = rows.length === limit
  const linkFor = (p: number) => {
    const sp = new URLSearchParams()
    if (q) sp.set('q', q)
    if (paused !== undefined) sp.set('paused', paused ? 'yes' : 'no')
    if (companyId) sp.set('company', companyId)
    if (p > 1) sp.set('page', String(p))
    const s = sp.toString()
    return s ? `/contacts?${s}` : '/contacts'
  }

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="contacts" signOut={signOutAction}>
      <h1>Contacts</h1>
      <p className="lede">
        Every person in the CRM, with what is on record for them: consent per channel — granted, refused, or
        never asked, and never asked is a no everywhere except cold email — the suppression list’s answer for each
        address they have, and the zone their quiet hours are checked in. These are the records the sender reads,
        read through the same functions. “Why can’t I reach them?” runs the sender’s own rules as a dry run and
        queues nothing.
      </p>

      <div className="note">
        <strong>Paused</strong> means a reply stopped every campaign for that person until somebody resumes
        them; a pause is also set by hand with a reason. {pausedCount > 0 ? `${pausedCount} on this page are paused.` : null}
        {repliesNote ? <> {repliesNote} As configured, this deployment pauses nobody on an email reply — a worker
          running elsewhere can, and a text reply through DoveSoft’s webhook does where that is set up;
          /settings/deployment shows both.</> : null}
      </div>

      <form method="get" action="/contacts" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 14 }}>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Name, address, title or company"
          maxLength={200}
          style={{ maxWidth: 320 }}
        />
        <select name="paused" defaultValue={paused === undefined ? '' : paused ? 'yes' : 'no'} style={{ padding: '6px 8px' }}>
          <option value="">Paused or not</option>
          <option value="yes">Only paused</option>
          <option value="no">Only not paused</option>
        </select>
        {companyId ? <input type="hidden" name="company" value={companyId} /> : null}
        <button type="submit" style={{ padding: '6px 12px', fontSize: 13 }}>Filter</button>
        {q || paused !== undefined || companyId ? <a href="/contacts" style={{ fontSize: 13 }}>Clear</a> : null}
      </form>

      <ContactsLedger
        rows={views}
        campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, channel: c.channel, status: c.status }))}
        canWrite={can(principal, 'contacts:write')}
        isOwner={can(principal, 'users:write')}
      />

      {page > 1 || hasMore ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          {page > 1 ? <a href={linkFor(page - 1)}>← Previous {limit}</a> : null}
          {page > 1 && hasMore ? ' · ' : null}
          {hasMore ? <a href={linkFor(page + 1)}>Next {limit} →</a> : null}
        </p>
      ) : null}
    </Shell>
  )
}
