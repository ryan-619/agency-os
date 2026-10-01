import { redirect } from 'next/navigation'
import { templatesList, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { getDb } from '@/lib/db'
import { dovesoft } from '@/lib/deployment'
import { mayReadTemplates, mayWriteTemplates, templateView } from '../../api/templates/rules'
import { TemplatesPanel, type TemplateRowView } from './panel'
import { TEMPLATES_LEDE } from './words'

/**
 * Settings → Templates (0019): the DLT-registered message templates every SMS
 * is drafted from.
 *
 * A record of a registration, not the registration. The header and the
 * template are registered as a pair on the operator's DLT portal (SmartPing,
 * for this agency); this page records what the portal holds — one at a
 * time, or from the portal's CSV export — so the composer on /contacts can
 * draft from it and the send path can check a message against it before it
 * goes. Nothing here registers anything with an operator, and nothing here
 * sends.
 *
 * WhatsApp and voice templates can be stored, and the page says that
 * sending either is not available: their DoveSoft APIs are not public.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function TemplatesPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }
  if (!mayReadTemplates(principal)) redirect('/settings')

  const rows = await templatesList(getDb() as unknown as AgencyDb, user.orgId)
  const views: TemplateRowView[] = rows.map(templateView).map((t) => ({
    id: t.id,
    channel: t.channel === 'whatsapp' || t.channel === 'voice' ? t.channel : 'sms',
    externalId: t.externalId,
    senderId: t.senderId,
    category: t.category,
    name: t.name,
    body: t.body,
    active: t.active,
    createdAt: t.createdAt,
    slots: t.slots,
  }))
  const activeSms = views.filter((v) => v.channel === 'sms' && v.active).length
  const sms = dovesoft()

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} current="settings" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Templates</h1>
      <p className="lede">{TEMPLATES_LEDE}</p>

      <div className={activeSms === 0 ? 'note note-warn' : 'note'} style={{ marginBottom: 12 }}>
        {activeSms === 0
          ? 'No SMS template is switched on, so no SMS can be drafted yet.'
          : `${activeSms} SMS template${activeSms === 1 ? ' is' : 's are'} on. An SMS is drafted from one with Draft SMS on /contacts — only to a person with a recorded SMS opt-in, under an SMS campaign — and approved by a person on /approvals before anything is sent.`}{' '}
        Sending goes through the worker, whose DoveSoft key this page cannot see; delivery reports and replies reach
        this deployment {sms.webhooks ? 'through its DoveSoft webhooks' : 'only once DOVESOFT_WEBHOOK_SECRET is set'} —{' '}
        <a href="/settings/deployment">Deployment</a>.
      </div>

      <TemplatesPanel templates={views} canWrite={mayWriteTemplates(principal)} />
    </Shell>
  )
}
