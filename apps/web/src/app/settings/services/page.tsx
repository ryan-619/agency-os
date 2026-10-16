import { redirect } from 'next/navigation'
import { NEEDS, NEED_KEYS } from '@agency/core'
import { servicesList, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { mayReadServices, mayWriteServices } from '../../api/services/rules'
import { ServicesPanel, type NeedView, type ServiceView } from './panel'

/**
 * Settings → Services (0022): what the agency sells, at what price, and which
 * needs each answers.
 *
 * The opportunity read (`get_opportunities`, the company page) matches a
 * business's observed needs to these, and the assistant pitches them at these
 * prices and never invents another. Changing the catalogue is an owner's act;
 * reading it is everyone's.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function ServicesPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  if (!mayReadServices(principal)) redirect('/settings')

  const rows = await servicesList(getDb() as unknown as AgencyDb, user.orgId)
  const services: ServiceView[] = rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    needs: s.needs,
    priceFrom: s.priceFrom,
    priceTo: s.priceTo,
    currency: s.currency,
    priceUnit: s.priceUnit,
    active: s.active,
  }))
  const needs: NeedView[] = NEED_KEYS.map((key) => ({ key, label: NEEDS[key].label, why: NEEDS[key].why }))

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="settings" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Services</h1>
      <p className="lede">
        What the agency sells, at what price, and which needs each one answers. When a business shows a need — no
        website, a slow site, few reviews, no WhatsApp — the company page and the assistant match it to the services
        here, and quote these prices. Nothing here contacts anybody.
      </p>
      <ServicesPanel services={services} needs={needs} canWrite={mayWriteServices(principal)} />
    </Shell>
  )
}
