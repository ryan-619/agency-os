import { redirect } from 'next/navigation'
import { can, parseIcpDefinition } from '@agency/core'
import { campaignActivity, campaignAutoPauses, listCampaigns, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { CampaignsPanel, type CampaignView } from '@/components/outreach/campaigns'
import { getDb } from '@/lib/db'
import { deployment, nothingWillSendNote } from '@/lib/deployment'
import { icpForOrg } from '@/lib/queries'

/**
 * Campaigns (PROMPT.md §8.4).
 *
 * The list, what each has actually done, and the builder. The numbers beside
 * a campaign are read from `touches`, not kept on the campaign row: a counter
 * is a second source of truth and its drift always favours sending.
 *
 * Each card can also ENROL — one draft per person at every qualifying,
 * freshly scanned company — previewed first, and parked on a person unless
 * the campaign auto-sends. Enrolling sends nothing; the worker does, and on
 * a deployment with no worker the card says that nothing will.
 *
 * A campaign the worker paused because its addresses bounced carries the
 * numbers from that `campaign.auto_paused` audit row, so the card can say
 * why it stopped and what to do.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function CampaignsPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const principal = { id: user.id, orgId: user.orgId, role: user.role }

  const db = getDb() as unknown as AgencyDb
  const rows = await listCampaigns(db, user.orgId)
  const autoPauses = await campaignAutoPauses(db, user.orgId)
  const views: CampaignView[] = await Promise.all(
    rows.map(async (c) => ({
      id: c.id,
      name: c.name,
      channel: (c.channel === 'linkedin' || c.channel === 'sms' ? c.channel : 'email') as CampaignView['channel'],
      dailyCap: c.dailyCap,
      quietStart: c.quietStart,
      quietEnd: c.quietEnd,
      autoSend: c.autoSend,
      status: c.status as CampaignView['status'],
      activity: await campaignActivity(db, user.orgId, c.id),
      autoPaused: (() => {
        const p = c.status === 'paused' ? autoPauses.get(c.id) : undefined
        return p
          ? { bouncePct: p.bouncePct, threshold: p.threshold, sentTo: p.sentTo, bounced: p.bounced, at: p.at.toISOString() }
          : null
      })(),
    })),
  )

  const icpRow = await icpForOrg(user.orgId)
  let orgLabel = 'Agency'
  if (icpRow) {
    try {
      orgLabel = parseIcpDefinition(icpRow.definition).label
    } catch {
      orgLabel = 'Agency'
    }
  }

  const d = deployment()

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  return (
    <Shell user={user} orgName={orgLabel} current="campaigns" signOut={signOutAction}>
      <h1>Campaigns</h1>
      <p className="lede">
        A campaign is where a message&apos;s daily cap and quiet hours come from, and whether it needs
        a person per message. Every message, approved or automatic, is checked against the
        suppression list, consent, quiet hours and the cap at the moment it is sent — the campaign
        sets the numbers, it does not skip the rules. An SMS campaign never sends by itself: each SMS
        is drafted per person from a registered template and approved by a person.
      </p>
      <CampaignsPanel
        campaigns={views}
        canWrite={can(principal, 'campaigns:write')}
        canAutoSend={can(principal, 'campaigns:set_auto_send')}
        canEnrol={can(principal, 'campaigns:write')}
        senderConnected={d.worker}
        noSenderNote={nothingWillSendNote(d)}
      />
    </Shell>
  )
}
