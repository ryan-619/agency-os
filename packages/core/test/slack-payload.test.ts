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
   * and no contact. The alarm still goes; it names no number (lead data),
   * says where the number is, and links to the Compliance page rather than
   * to anything built from it.
   *
   * And it says only what is known (review round 7, [8]). It read "Nothing
   * in the app holds the number it came from" — false when a redelivery of
   * a STOP already recorded, or a shared number held in one org before
   * another threw, reached this alarm — so the person was sent to suppress
   * and pause what was done already. Now: check first, record if missing.
   */
  it('names no message or contact, says to check the suppression list first, and links to /compliance', () => {
    const unplaced: SlackOptOutNotRecordedEvent = { ...EVENT, touchId: null, contactId: null }
    const text = slackOptOutNotRecordedPayload(unplaced, 'https://app.test/').text
    expect(text).toBe(
      'OPT-OUT NOT RECORDED. Somebody asked to be left alone through a reply and no suppression row could be written. ' +
        'A person has to record it now.\n' +
        'no message or contact named\n' +
        'Whose number it was is not known here, and it may not be on the suppression list: check the Suppressions page for the ' +
        'number in the provider’s inbound log, and record it there if it is missing. Anybody holding the number may already be ' +
        'paused. The Compliance page counts it.\n' +
        'https://app.test/compliance',
    )
    // Nothing it cannot know.
    expect(text).not.toContain('Nothing in the app holds')
    expect(text).not.toContain('no message on file')
    const bare = slackOptOutNotRecordedPayload(unplaced, null).text
    expect(bare).not.toMatch(/https?:/)
    expect(bare).toContain('It is counted on the Compliance page in the app.')
    expect(bare).not.toContain('touch ')
  })

  /**
   * An email stop matched to a contact by address alone names no message of
   * ours, but the contact's record holds the address — so the alarm points
   * at the Suppressions page, and never says nothing in the app holds it.
   */
  it('for a contact with no message on file, links to /suppressions and never says nothing holds it', () => {
    const placed: SlackOptOutNotRecordedEvent = { ...EVENT, touchId: null, contactId: 'c-1' }
    const text = slackOptOutNotRecordedPayload(placed, 'https://app.test/').text
    expect(text).toContain('no message on file · contact c-1')
    expect(text).toContain('https://app.test/suppressions')
    expect(text).not.toContain('Nothing in the app holds')
    expect(slackOptOutNotRecordedPayload(placed, null).text).toContain('Record it on the Suppressions page in the app.')
  })

  /**
   * Review round 7, [7]: a colleague replying all to our message asked to
   * stop, the reply was filed under the contact the message went to, and its
   * recording threw. Suppressing the CONTACT's address would record nobody's
   * opt-out, so the message names no contact and says whose address to
   * record — never the address itself.
   */
  it('for a stop from somebody other than the contact, says to record the sender’s address and names no contact', () => {
    const colleague: SlackOptOutNotRecordedEvent = { ...EVENT, contactId: null, fromIsContact: false }
    expect(slackOptOutNotRecordedPayload(colleague, 'https://app.test').text).toBe(
      'OPT-OUT NOT RECORDED. Somebody asked to be left alone through a reply and no suppression row could be written. ' +
        'A person has to record it now.\n' +
        'touch 00000000-0000-4000-8000-000000000007 · sent by somebody other than the contact\n' +
        'The reply came from another address than the contact that message went to, so record THAT address, never the ' +
        'contact’s: read it from the mail itself, check the Suppressions page for it, and record it there if it is missing.\n' +
        'https://app.test/suppressions',
    )
    expect(slackOptOutNotRecordedPayload({ ...colleague, touchId: null }, null).text).toContain(
      'no message on file · sent by somebody other than the contact\n',
    )
    expect(slackOptOutNotRecordedPayload(colleague, null).text).toContain('Record it on the Suppressions page in the app.')
    // Absent, nothing is said about the sender: every other alarm reads as before.
    expect(slackOptOutNotRecordedPayload(EVENT, 'https://app.test').text).not.toContain('somebody other than')
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
