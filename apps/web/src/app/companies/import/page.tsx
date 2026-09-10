import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { assertCan, parseIcpDefinition } from '@agency/core'
import { importCompanies, parseCompanySeeds } from '@agency/db/repository'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { icpForOrg } from '@/lib/queries'
import { getDb } from '@/lib/db'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** Cap the paste box so a mis-paste cannot try to import a novel. */
const MAX_ROWS = 5000

export default async function ImportCompanies({
  searchParams,
}: {
  searchParams: Promise<{ inserted?: string; present?: string; error?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const icpRow = await icpForOrg(user.orgId)
  const icp = icpRow ? parseIcpDefinition(icpRow.definition) : null
  const { inserted, present, error } = await searchParams

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={icp?.label ?? 'Agency'} current="companies" signOut={signOutAction}>
      <p className="crumb"><a href="/companies">← Companies</a></p>
      <h1>Import companies</h1>
      <p className="lede">
        One domain per line, optionally followed by a comma and the company name. Blank lines and
        lines starting with <code>#</code> are ignored. Duplicates are dropped at write time, so
        importing the same list twice changes nothing.
      </p>

      {error ? <p className="err">{error}</p> : null}
      {inserted !== undefined ? (
        <div className="note">
          <strong>Imported {inserted} new {Number(inserted) === 1 ? 'company' : 'companies'}.</strong>
          {present && Number(present) > 0 ? <> {present} were already in the pipeline.</> : null}
          <p style={{ margin: '8px 0 0' }}>
            Nothing has been scanned yet — they have no score and no findings until{' '}
            <code>npm run scan</code> runs.
          </p>
        </div>
      ) : null}

      <form
        action={async (formData: FormData) => {
          'use server'
          const s = await auth()
          if (!s?.user) redirect('/signin')
          // Same capability check the UI uses, applied where it counts.
          assertCan(s.user, 'companies:write')

          const text = String(formData.get('csv') ?? '')
          let rows: Array<{ domain: string; name: string }>
          try {
            rows = parseCompanySeeds(text)
          } catch (err) {
            const message = err instanceof Error ? err.message : 'could not read that list'
            redirect(`/companies/import?error=${encodeURIComponent(message)}`)
          }
          if (!rows.length) redirect('/companies/import?error=Nothing+to+import')
          if (rows.length > MAX_ROWS) {
            redirect(`/companies/import?error=${encodeURIComponent(`That is ${rows.length} rows; the limit is ${MAX_ROWS}.`)}`)
          }

          const result = await importCompanies(
            getDb() as never, s.user.orgId, rows, 'import',
          )
          log.info('companies imported', {
            orgId: s.user.orgId, inserted: result.inserted, alreadyPresent: result.alreadyPresent,
          })
          revalidatePath('/companies')
          redirect(`/companies/import?inserted=${result.inserted}&present=${result.alreadyPresent}`)
        }}
      >
        <label htmlFor="csv">Domains</label>
        <textarea
          id="csv"
          name="csv"
          rows={12}
          required
          placeholder={'rentman.io,Rentman\neagronom.com,eAgronom\namberlo.io'}
        />
        <button type="submit" style={{ width: 'auto', padding: '8px 18px' }}>Import</button>
      </form>

      <div className="note" style={{ marginTop: 24 }}>
        Importing a company records only that you intend to look at it. Nothing is fetched, nothing
        is claimed, and no message can be sent — the send path does not exist until Phase 4.
      </div>
    </Shell>
  )
}
