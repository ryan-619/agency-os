import { companiesEditView, type AgencyDb } from '@agency/db/queries'
import { getDb } from '@/lib/db'
import { CompanyEditForm } from './edit-form'
import type { CompanySlotProps } from './slot'

/**
 * A company's own record — name, country, timezone, and since 0021 what it
 * is: industry, city, stage, headcount with its source, a line on what it
 * does — under its page's lede, with an edit control for anyone who may write
 * companies. What it is comes from research (the agent's or a person's), never
 * from a scan, and the line says so.
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
      {company.industry || company.city || company.stage || company.headcount !== null || company.description ? (
        <div className="muted" style={{ marginTop: 2 }}>
          {[
            company.industry,
            company.city,
            company.stage ? `stage ${company.stage}` : null,
            company.headcount !== null ? `~${company.headcount.toLocaleString('en')} staff` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {company.headcountSource ? <> (headcount per {company.headcountSource})</> : null}
          {company.description ? <div style={{ color: 'var(--ink)', marginTop: 2 }}>{company.description}</div> : null}
          <span style={{ fontSize: 11.5 }}> — recorded from research, not observed by a scan.</span>
        </div>
      ) : null}
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
          industry={company.industry}
          city={company.city}
          stage={company.stage}
          headcount={company.headcount}
          headcountSource={company.headcountSource}
          description={company.description}
        />
      ) : null}
    </div>
  )
}
