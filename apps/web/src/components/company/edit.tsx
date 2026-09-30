import { companiesEditView, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { CompanyEditForm } from './edit-form'
import type { CompanySlotProps } from './slot'

/**
 * A company's own record — name, country, timezone — under its page's lede,
 * with an edit control for anyone who may write companies.
 *
 * The timezone is shown with what it is FOR: quiet hours are checked in it for
 * every contact here who has no zone of their own, and when neither is set the
 * send path refuses rather than guess. So a missing zone is stated as a
 * consequence, with the number of people it stops, not as an empty field.
 */
export async function CompanyEditSlot(props: CompanySlotProps): Promise<React.ReactNode> {
  const view = await companiesEditView(getDb() as unknown as AgencyDb, props.orgId, props.companyId)
  if (!view) return null
  const { company, contactsWithoutZone } = view
  const people = `${contactsWithoutZone} ${contactsWithoutZone === 1 ? 'person' : 'people'}`

  return (
    <div style={{ margin: '-4px 0 16px', fontSize: 13 }}>
      <div className="muted">
        Country {company.country ? <strong style={{ color: 'var(--ink)' }}>{company.country}</strong> : <>not recorded</>}
        {' · '}
        Timezone {company.timeZone ? <code>{company.timeZone}</code> : <>not declared</>}
        {company.timeZone && contactsWithoutZone > 0 ? (
          <> — used for the {people} here with no zone of their own</>
        ) : null}
      </div>
      {!company.timeZone && contactsWithoutZone > 0 ? (
        <div className="err-line">
          {people} here {contactsWithoutZone === 1 ? 'has' : 'have'} no zone of their own either, so nothing can be sent
          to them until one is declared — here or on them. Quiet hours cannot be checked without it.
        </div>
      ) : null}
      {props.canWrite ? (
        <CompanyEditForm
          companyId={company.id}
          name={company.name}
          country={company.country}
          timeZone={company.timeZone}
        />
      ) : null}
    </div>
  )
}
