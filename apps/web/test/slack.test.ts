/**
 * Delivering to Slack, with the network injected.
 *
 * The webhook URL is the credential, so the thing every case checks is that
 * it appears in no result, no log line and no audit row — whatever the
 * network did. `lib/slack.ts` carries `server-only` and reads `env()`, so
 * what is tested is `lib/slack-post.ts`: the transport, and the
 * build → post → log → audit path that `notify` hands its URL, origin and
 * database to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverNotification, postToSlack, type NotificationAuditEntry } from '../src/lib/slack-post'
import type { NotificationEvent, SlackPayload } from '../src/lib/slack-message'

const URL_ = 'https://hooks.slack.com/services/T0SECRET/B0SECRET/xxxSECRETxxx'
const ORIGIN = 'https://app.test'
const PAYLOAD: SlackPayload = { text: 'hello' }
const ORG = '00000000-0000-4000-8000-00000000000a'
const EVENT: NotificationEvent = {
  kind: 'deal_closed', orgId: ORG, dealId: '00000000-0000-4000-8000-000000000004', companyDomain: 'acme.example', stage: 'won',
}

const ok = (status = 200, body = 'ok'): typeof fetch => vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
const refused = (status: number, body: string): typeof fetch => ok(status, body)
const throwing = (err: unknown): typeof fetch => vi.fn(async () => { throw err }) as unknown as typeof fetch
const calls = (f: typeof fetch): [string, RequestInit][] => (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]

/** An audit writer that records what would have been inserted. */
function fakeAudit(): { audit: (entry: NotificationAuditEntry) => Promise<void>; rows: NotificationAuditEntry[] } {
  const rows: NotificationAuditEntry[] = []
  return { audit: async (entry) => { rows.push(entry) }, rows }
}

let logged: string[]

beforeEach(() => {
  logged = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)) })
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logged.push(String(line)) })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('postToSlack', () => {
  it('reports a 200 as delivered', async () => {
    const fetchImpl = ok()
    expect(await postToSlack(URL_, PAYLOAD, fetchImpl)).toEqual({ ok: true, status: 200 })
    const [url, init] = calls(fetchImpl)[0]!
    expect(url).toBe(URL_)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD)
  })

  it('keeps Slack’s short token when the webhook is refused', async () => {
    expect(await postToSlack(URL_, PAYLOAD, refused(404, 'no_service'))).toEqual({ ok: false, status: 404, error: 'no_service' })
  })

  it('reduces any other body to the status', async () => {
    expect(await postToSlack(URL_, PAYLOAD, refused(500, `<html>${URL_}</html>`))).toEqual({ ok: false, status: 500, error: 'http_500' })
  })

  it('does not follow a redirect, and reports it as a refusal', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as unknown as typeof fetch
    expect(await postToSlack(URL_, PAYLOAD, fetchImpl)).toEqual({ ok: false, status: 302, error: 'http_302' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports a network failure by its class, never its message', async () => {
    const err = new TypeError(`fetch failed: ${URL_}`)
    const result = await postToSlack(URL_, PAYLOAD, throwing(err))
    expect(result).toEqual({ ok: false, status: null, error: 'TypeError' })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('gives up after three seconds, once', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
        }),
    ) as unknown as typeof fetch
    const pending = postToSlack(URL_, PAYLOAD, fetchImpl)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await pending).toEqual({ ok: false, status: null, error: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never throws, whatever fetch throws', async () => {
    expect(await postToSlack(URL_, PAYLOAD, throwing('a string, not an Error'))).toEqual({ ok: false, status: null, error: 'UnknownError' })
  })
})

describe('deliverNotification', () => {
  it('posts, logs by kind and status, and writes notification.sent', async () => {
    const fetchImpl = ok()
    const { audit, rows } = fakeAudit()
    await deliverNotification(EVENT, { webhookUrl: URL_, origin: ORIGIN, fetchImpl, audit })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      orgId: ORG,
      actor: 'system',
      action: 'notification.sent',
      subjectType: 'deal',
      subjectId: '00000000-0000-4000-8000-000000000004',
      detail: { channel: 'slack', event: 'deal_closed', status: 200 },
    })
    expect(logged.some((l) => l.includes('slack notification sent') && l.includes('"deal_closed"'))).toBe(true)
  })

  it('builds the link from the origin it was given', async () => {
    const fetchImpl = ok()
    await deliverNotification(EVENT, { webhookUrl: URL_, origin: 'https://myagencyos.in', fetchImpl, audit: fakeAudit().audit })
    const [, init] = calls(fetchImpl)[0]!
    expect(init.body as string).toContain('https://myagencyos.in/companies/acme.example')
  })

  it('writes notification.failed with the short error when Slack refuses', async () => {
    const { audit, rows } = fakeAudit()
    await deliverNotification(EVENT, { webhookUrl: URL_, origin: ORIGIN, fetchImpl: refused(404, 'no_service'), audit })
    expect(rows[0]).toMatchObject({ action: 'notification.failed', detail: { channel: 'slack', status: 404, error: 'no_service' } })
    expect(logged.some((l) => l.includes('slack notification failed') && l.includes('no_service'))).toBe(true)
  })

  it('files an event with no row of its own under the org', async () => {
    const { audit, rows } = fakeAudit()
    await deliverNotification(
      { kind: 'worker_silent', orgId: ORG, lastTickAt: null, ageSeconds: null },
      { webhookUrl: URL_, origin: ORIGIN, fetchImpl: ok(), audit },
    )
    expect(rows[0]).toMatchObject({ subjectType: 'org', subjectId: null })
  })

  it('keeps the ids beside the subject, so a reply’s contact is on the row too', async () => {
    const { audit, rows } = fakeAudit()
    await deliverNotification(
      { kind: 'reply', orgId: ORG, contactId: 'c1', touchId: 't1', companyDomain: 'acme.example', replyKind: 'interested', paused: true, suppressed: false },
      { webhookUrl: URL_, origin: ORIGIN, fetchImpl: ok(), audit },
    )
    expect(rows[0]).toMatchObject({ subjectType: 'touch', subjectId: 't1', detail: { ids: { touchId: 't1', contactId: 'c1' } } })
  })

  it('survives the audit write failing, and says so by class', async () => {
    const audit = async (): Promise<void> => { throw new TypeError(`insert failed ${URL_}`) }
    await expect(deliverNotification(EVENT, { webhookUrl: URL_, origin: ORIGIN, fetchImpl: ok(), audit })).resolves.toBeUndefined()
    expect(logged.some((l) => l.includes('audit row not written') && l.includes('TypeError'))).toBe(true)
  })

  it('puts the URL in no log line and no audit row, whatever happened', async () => {
    const { audit, rows } = fakeAudit()
    const deps = { webhookUrl: URL_, origin: ORIGIN, audit }
    await deliverNotification(EVENT, { ...deps, fetchImpl: throwing(new TypeError(`fetch failed: ${URL_}`)) })
    await deliverNotification(EVENT, { ...deps, fetchImpl: refused(403, `forbidden ${URL_}`) })
    await deliverNotification(EVENT, { ...deps, fetchImpl: ok() })
    const everything = JSON.stringify({ rows, logged })
    expect(everything).not.toContain('SECRET')
    expect(everything).not.toContain('hooks.slack.com')
  })
})
