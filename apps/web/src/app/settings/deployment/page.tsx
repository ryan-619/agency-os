import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import {
  APPLIED_MIGRATION_SQL, EXPECTED_MIGRATION, compareSchema, parseAppliedMigration,
} from '@agency/db/schema-version'
import { secretsKeyFromEnv, type AgencyDb } from '@agency/db/queries'
import { auth, signOut } from '@/auth'
import { Shell } from '@/components/shell'
import { When } from '@/components/when'
import { agentConfigured } from '@/lib/agent'
import { getDb } from '@/lib/db'
import { deployment, dovesoft } from '@/lib/deployment'
import { env } from '@/lib/env'
import { workerStatus, type WorkerStatus } from '@/lib/worker-status'
import { deploymentFacts, schemaSentence, sendingAnswer, workerLine, workerModes } from '../facts'
import { orgIdentity } from '../org'

/**
 * Settings → Deployment: "why does nothing send?" as a page.
 *
 * Three kinds of fact, kept apart because they answer different questions:
 * what THIS web deployment is configured to do (`deployment()`, by variable
 * name — never a value, never a URL that could carry a credential, §2.3);
 * what the worker last said about itself (its heartbeat, an observation, and
 * the only thing here that can say whether anything is actually sending);
 * and whether the database is at the migration this code expects, computed
 * exactly as `/api/health` computes it.
 *
 * Read only. The worker's own variables live on its host and are invisible
 * from here; the page says so rather than guessing at them.
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `/api/health`'s read of the ledger, restated: the SQL and the parser are
 * shared from @agency/db/schema-version, so this is the same statement, and
 * a missing ledger is an answer ('unknown'), not an exception.
 */
async function appliedMigration(): Promise<string | null> {
  try {
    const res = await getDb().execute(sql.raw(APPLIED_MIGRATION_SQL))
    return parseAppliedMigration(res.rows)
  } catch {
    // Swallowed and not logged: 'unknown' is the honest answer, and a driver
    // error can carry the DSN (§2.3).
    return null
  }
}

/** The web app's variables, by name, and what reads each. Required ones are listed as such. */
const VARIABLES: readonly { readonly name: string; readonly reads: string; readonly required?: true }[] = [
  { name: 'DATABASE_URL', reads: 'every page', required: true },
  { name: 'AUTH_SECRET', reads: 'sign-in sessions', required: true },
  { name: 'AUTH_URL', reads: 'the origin sign-in links point at', required: true },
  { name: 'SMTP_HOST', reads: 'sign-in mail', required: true },
  { name: 'SMTP_USER', reads: 'the sign-in mail relay’s login' },
  { name: 'SMTP_PASSWORD', reads: 'the sign-in mail relay’s login' },
  { name: 'AGENT_URL', reads: 'chat, and every “will this send?” sentence' },
  { name: 'AGENT_INTERNAL_TOKEN', reads: 'proves a request to the worker came from here' },
  { name: 'INBOUND_WEBHOOK_SECRET', reads: '/api/inbound/email' },
  { name: 'RESEND_WEBHOOK_SECRET', reads: '/api/inbound/resend' },
  { name: 'RESEND_API_KEY', reads: '/api/inbound/resend, to fetch a reply’s body' },
  { name: 'CRON_SECRET', reads: '/api/cron/rescan and /api/cron/digest' },
  { name: 'SLACK_WEBHOOK_URL', reads: 'notifications' },
  { name: 'UNSUBSCRIBE_SECRET', reads: '/api/unsubscribe' },
  { name: 'DOVESOFT_WEBHOOK_SECRET', reads: '/api/inbound/dovesoft/dlr and /sms (SMS delivery reports and replies)' },
  { name: 'DOVESOFT_ORG_ID', reads: 'the org an unplaceable DoveSoft text or report is filed under' },
  { name: 'SECRETS_KEY', reads: 'encrypting connector credentials' },
  { name: 'VERCEL_ENV', reads: 'the cron routes, which run only in production (set by the platform)' },
]

export default async function DeploymentPage() {
  const session = await auth()
  if (!session?.user) redirect('/signin')
  const user = session.user
  const org = await orgIdentity(user.orgId)

  const e = env()
  const flags = deployment()
  const sms = dovesoft()

  let worker: WorkerStatus | null = null
  let workerError: string | undefined
  try {
    worker = await workerStatus(getDb() as unknown as AgencyDb, new Date())
  } catch (err) {
    // The class only: a driver error can carry the DSN (§2.3).
    workerError = err instanceof Error ? err.name : 'UnknownError'
  }
  const line = workerLine(worker, workerError)
  const modes = workerModes(worker)
  const sending = sendingAnswer(worker)

  const applied = await appliedMigration()
  const state = compareSchema(applied)
  const schemaLine = schemaSentence(state, EXPECTED_MIGRATION, applied)

  const secretsKey = secretsKeyFromEnv() !== null ? 'valid' : e.SECRETS_KEY ? 'malformed' : 'unset'
  const facts = deploymentFacts({
    flags,
    agent: agentConfigured(),
    secretsKey,
    vercelEnv: e.VERCEL_ENV,
    inboundJson: Boolean(e.INBOUND_WEBHOOK_SECRET),
    inboundResend: Boolean(e.RESEND_WEBHOOK_SECRET && e.RESEND_API_KEY),
    rescanBatchSize: e.RESCAN_BATCH_SIZE,
  })

  // Presence only. `env()` has already folded a blank value to unset, so a
  // copied `.env.example` line reads as what it is.
  const set = (name: string): boolean => {
    const v = (e as unknown as Record<string, unknown>)[name]
    return typeof v === 'string' ? v.length > 0 : v !== undefined && v !== null
  }
  const variableState = (name: string, required?: true): { text: string; on: boolean } => {
    if (required) return { text: 'set (required)', on: true }
    if (name === 'SECRETS_KEY' && secretsKey === 'malformed') return { text: 'set, not a valid key', on: false }
    return set(name) ? { text: 'set', on: true } : { text: 'not set', on: false }
  }

  const signOutAction = async () => {
    'use server'
    await signOut({ redirectTo: '/signin' })
  }

  const tone = (t: 'ok' | 'warn' | 'plain') => (t === 'warn' ? 'note note-warn' : 'note')

  return (
    <Shell user={user} orgName={org.name} current="deployment" signOut={signOutAction}>
      <p className="crumb"><a href="/settings">Settings</a> /</p>
      <h1>Deployment</h1>
      <p className="lede">
        What this deployment is configured to do, what the worker last said about itself, and whether the database
        is at the schema this code expects. Variables are named here, never shown.
      </p>

      <h2>Why would nothing send?</h2>
      <div className={tone(sending.tone)}>
        <strong>{sending.text}</strong>
      </div>

      <h2>Worker</h2>
      <div className={tone(line.tone)}>
        <strong>{line.text}</strong>
        {line.lastSeenAt ? (
          <span className="muted"> Last heartbeat <When iso={line.lastSeenAt.toISOString()} />.</span>
        ) : null}
        {modes ? <div style={{ marginTop: 6 }}>{modes}</div> : null}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        The worker&apos;s own variables — its model credential, its mail relay and <code>MAIL_FROM</code>,{' '}
        <code>WEB_PUBLIC_URL</code>, <code>OUTREACH_BOUNCE_PAUSE_PCT</code>, and DoveSoft&apos;s{' '}
        <code>DOVESOFT_API_KEY</code> and <code>DOVESOFT_ENTITY_ID</code> for sending SMS — live on its host. This page
        sees only what its heartbeat reports.
      </p>

      <h2>Schema</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 200 }}>This code expects</th><td className="mono">{EXPECTED_MIGRATION}</td></tr>
          <tr><th>The database has applied</th><td className="mono">{applied ?? '— (unreadable)'}</td></tr>
          <tr>
            <th>State</th>
            <td><span className={state === 'ok' ? 'tag on' : state === 'ahead' ? 'tag' : 'tag warn'}>{state}</span></td>
          </tr>
        </tbody>
      </table>
      <div className={tone(schemaLine.tone)} style={{ marginTop: 10 }}>{schemaLine.text}</div>
      <p className="muted" style={{ fontSize: 13 }}>
        The same check <code>/api/health</code> reports, and <code>/api/health?strict=1</code> answers with its
        status code.
      </p>

      <h2>What this deployment can do</h2>
      <table>
        <thead><tr><th>Area</th><th /><th>On this deployment</th><th>Read from</th></tr></thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.area}>
              <td style={{ width: 170 }}><strong>{f.area}</strong></td>
              <td style={{ width: 50 }}><span className={f.on ? 'tag on' : 'tag'}>{f.on ? 'yes' : 'no'}</span></td>
              <td>{f.sentence}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>{f.vars.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 13 }}>
        Each line is configuration: it says a route exists and holds what it needs, never that the thing behind it
        has been seen to work.
      </p>

      <h2>SMS through DoveSoft</h2>
      {sms.sentences.map((sentence, i) => (
        <div
          key={sentence}
          className={(i === 0 && !sms.webhooks) || (i === 1 && !sms.org) ? 'note note-warn' : 'note'}
          style={{ marginBottom: 8 }}
        >
          {sentence}
        </div>
      ))}
      <table>
        <tbody>
          <tr>
            <th style={{ width: 200 }}>Delivery reports</th>
            <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{sms.urls.dlr}</td>
          </tr>
          <tr>
            <th>Texts sent back</th>
            <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{sms.urls.sms}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 13 }}>
        Register these two with DoveSoft, with the secret in place of <code>&lt;DOVESOFT_WEBHOOK_SECRET&gt;</code> —
        it is never shown here. A route that can carry a header may send it as <code>x-dovesoft-token</code> instead.
        The registered DLT templates are recorded on <a href="/settings/templates">Templates</a>.
      </p>

      <h2>Variables</h2>
      <table>
        <thead><tr><th>Variable</th><th>State</th><th>Read by</th></tr></thead>
        <tbody>
          {VARIABLES.map((v) => {
            const s = variableState(v.name, v.required)
            return (
              <tr key={v.name}>
                <td className="mono">{v.name}</td>
                <td><span className={s.on ? 'tag on' : 'tag'}>{s.text}</span></td>
                <td className="muted">{v.reads}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 13 }}>
        A required variable is listed as set because this page could not render without it. Every optional one
        fails closed when unset: the feature that reads it refuses, and says so where it is used.
      </p>
    </Shell>
  )
}
