import { redirect } from 'next/navigation'
import { can } from '@agency/core'
import { orgProfileRead, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { ProfilePanel } from './panel'

/**
 * Settings → Business profile (0023): what every quote prints about the
 * agency — its legal name and address, GSTIN and the GST it charges, the UPI
 * ID an advance is paid to, how long a quote is valid, the advance it asks,
 * its standard terms, and a brochure link. Owners change it; everyone reads it.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function ProfilePage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  const profile = await orgProfileRead(getDb() as unknown as AgencyDb, user.orgId)

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="profile" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Business profile</h1>
      <p className="lede">
        What your quotes print about you, and where the advance is paid. GST is added only when you give a GSTIN. A quote
        keeps the details it was sent with, so changing them here changes drafts and new quotes, never one already sent.
      </p>
      <ProfilePanel
        canWrite={can(principal, 'users:write')}
        initial={{
          legalName: profile.legalName ?? '',
          address: profile.address ?? '',
          phone: profile.phone ?? '',
          email: profile.email ?? '',
          website: profile.website ?? '',
          gstin: profile.gstin ?? '',
          gstRate: String(profile.gstRate),
          upiVpa: profile.upiVpa ?? '',
          upiPayee: profile.upiPayee ?? '',
          advancePercent: String(profile.advancePercent),
          quoteValidityDays: String(profile.quoteValidityDays),
          quoteTerms: profile.quoteTerms ?? '',
          brochureUrl: profile.brochureUrl ?? '',
        }}
      />
    </Shell>
  )
}
