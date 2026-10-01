/**
 * The Slack message two processes post (§5.5: ids and a link, never lead
 * data). The web app's whole vocabulary is tested in
 * apps/web/test/slack-message.test.ts, which also pins that the web builds
 * this alarm through the function below; the worker's delivery of it is
 * apps/agent/test/notify.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  SLACK_PAYLOAD_MAX_TEXT,
  slackLink,
  slackOptOutNotRecordedPayload,
  slackPayloadOf,
  type SlackOptOutNotRecordedEvent,
} from '../src/index.js'

const EVENT: SlackOptOutNotRecordedEvent = {
  kind: 'opt_out_not_recorded',
  orgId: '00000000-0000-4000-8000-00000000000a',
  touchId: '00000000-0000-4000-8000-000000000007',
  contactId: '00000000-0000-4000-8000-000000000001',
  path: 'reply',
}

describe('slackOptOutNotRecordedPayload', () => {
  it('names the path, the ids and the suppressions page — and nothing else', () => {
    expect(slackOptOutNotRecordedPayload(EVENT, 'https://app.test').text).toBe(
      'OPT-OUT NOT RECORDED. Somebody asked to be left alone through a reply and no suppression row could be written. ' +
        'A person has to record it now.\n' +
        'touch 00000000-0000-4000-8000-000000000007 · contact 00000000-0000-4000-8000-000000000001\n' +
        'https://app.test/suppressions',
    )
  })

  it.each([
    ['unsubscribe', 'through the unsubscribe link'],
    ['erasure', 'through an erasure request'],
    ['reply', 'through a reply'],
  ] as const)('says the %s path in words', (path, words) => {
    expect(slackOptOutNotRecordedPayload({ ...EVENT, path }, 'https://app.test').text).toContain(words)
  })

  it('says "unknown" for a contact nobody could name', () => {
    expect(slackOptOutNotRecordedPayload({ ...EVENT, contactId: null }, 'https://app.test').text).toContain('contact unknown')
  })

  /** A worker with no WEB_PUBLIC_URL does not know where the app is, and does not invent it. */
  it('posts without a link when there is no origin, and says where to go instead', () => {
    const text = slackOptOutNotRecordedPayload(EVENT, null).text
    expect(text).not.toMatch(/https?:/)
    expect(text).toContain('Record it on the Suppressions page in the app.')
    expect(text).toMatch(/^OPT-OUT NOT RECORDED\./)
  })

  /**
   * A STOP texted from a number no single contact holds has no message row
   * and no contact. The alarm still goes; it names no number (lead data, and
   * the app holds none to name), says where the number is, and links to the
   * Compliance page rather than to anything built from it.
   */
  it('says there is no message on file and links to /compliance, for an alarm with no touch', () => {
    const unplaced: SlackOptOutNotRecordedEvent = { ...EVENT, touchId: null, contactId: null }
    expect(slackOptOutNotRecordedPayload(unplaced, 'https://app.test/').text).toBe(
      'OPT-OUT NOT RECORDED. Somebody asked to be left alone through a reply and no suppression row could be written. ' +
        'A person has to record it now.\n' +
        'no message on file · contact unknown\n' +
        'Nothing in the app holds the number it came from: read it from the provider’s inbound log and record it on the Suppressions page. ' +
        'The Compliance page counts it.\n' +
        'https://app.test/compliance',
    )
    const bare = slackOptOutNotRecordedPayload(unplaced, null).text
    expect(bare).not.toMatch(/https?:/)
    expect(bare).toContain('It is counted on the Compliance page in the app.')
    expect(bare).not.toContain('touch ')
  })

  /** The builder names its fields; a row with more on it never reaches the channel. */
  it('drops decoy lead data handed to it through a cast', () => {
    const decoy = {
      ...EVENT, body: 'please stop emailing me', email: 'priya@rentman.io', name: 'Priya Sharma', domain: 'priya-rentman.io.inbound',
    } as unknown as SlackOptOutNotRecordedEvent
    const text = slackOptOutNotRecordedPayload(decoy, 'https://app.test').text
    for (const leak of ['please stop', 'priya@', 'Priya', '.inbound']) expect(text).not.toContain(leak)
  })
})

describe('slackPayloadOf and slackLink', () => {
  it('joins lines, and cuts a message past Slack’s limit with an ellipsis', () => {
    expect(slackPayloadOf(['a', 'b'])).toEqual({ text: 'a\nb' })
    const long = slackPayloadOf(['x'.repeat(SLACK_PAYLOAD_MAX_TEXT + 10)]).text
    expect(long).toHaveLength(SLACK_PAYLOAD_MAX_TEXT)
    expect(long.endsWith('…')).toBe(true)
  })

  it('builds a link on the origin with its trailing slashes removed, or none without one', () => {
    expect(slackLink('https://app.test//', '/inbox')).toBe('https://app.test/inbox')
    expect(slackLink(null, '/inbox')).toBeNull()
  })
})
