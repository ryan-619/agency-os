/**
 * The Twilio edge (PROMPT.md §8.5).
 *
 * These endpoints can write a SUPPRESSION and a call record, so the
 * signature is the whole boundary. The tests that matter are the ones about
 * refusing: no token, no signature, a tampered parameter, a different URL.
 */
import { describe, it, expect } from 'vitest'
import {
  handoffTwiml, parseForm, relayTwiml, sayAndHangupTwiml, twilioSignature, verifyTwilioSignature,
} from '../src/twilio.js'

const TOKEN = 'a-test-auth-token'
const URL_ = 'https://voice.example.com/twiml/voice'
const PARAMS = { CallSid: 'CA123', From: '+14155550100', To: '+14155550199' }

describe('the request signature', () => {
  it('accepts a signature it computed itself', () => {
    const sig = twilioSignature(TOKEN, URL_, PARAMS)
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, sig)).toBe(true)
  })

  /**
   * The one that matters most. An unconfigured deployment must refuse
   * everything rather than accept everything — the same choice
   * `/api/inbound/email` makes.
   */
  it('FAILS CLOSED with no auth token configured', () => {
    const sig = twilioSignature(TOKEN, URL_, PARAMS)
    expect(verifyTwilioSignature(undefined, URL_, PARAMS, sig)).toBe(false)
    expect(verifyTwilioSignature('', URL_, PARAMS, sig)).toBe(false)
  })

  it('refuses a missing signature', () => {
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, undefined)).toBe(false)
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, '')).toBe(false)
  })

  it('refuses a tampered parameter', () => {
    const sig = twilioSignature(TOKEN, URL_, PARAMS)
    expect(verifyTwilioSignature(TOKEN, URL_, { ...PARAMS, From: '+19995550000' }, sig)).toBe(false)
  })

  it('refuses an added parameter', () => {
    const sig = twilioSignature(TOKEN, URL_, PARAMS)
    expect(verifyTwilioSignature(TOKEN, URL_, { ...PARAMS, Extra: 'x' }, sig)).toBe(false)
  })

  /** Behind a proxy the socket's URL is not the one Twilio signed. */
  it('refuses a signature computed for a different URL', () => {
    const sig = twilioSignature(TOKEN, 'https://voice.example.com/twiml/status', PARAMS)
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, sig)).toBe(false)
  })

  it('refuses the wrong auth token', () => {
    const sig = twilioSignature('someone-elses-token', URL_, PARAMS)
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, sig)).toBe(false)
  })

  /** Parameters are appended in sorted order, so order must not matter. */
  it('does not depend on the order the parameters arrive in', () => {
    const a = twilioSignature(TOKEN, URL_, { b: '2', a: '1', c: '3' })
    const b = twilioSignature(TOKEN, URL_, { c: '3', a: '1', b: '2' })
    expect(a).toBe(b)
  })
})

describe('parseForm', () => {
  it('reads an urlencoded body, including + and %', () => {
    expect(parseForm('From=%2B14155550100&Body=stop+calling')).toEqual({
      From: '+14155550100',
      Body: 'stop calling',
    })
  })
  it('is empty for an empty body', () => {
    expect(parseForm('')).toEqual({})
  })
})

describe('the TwiML', () => {
  const twiml = relayTwiml({
    wsUrl: 'wss://voice.example.com/relay',
    actionUrl: 'https://voice.example.com/twiml/action',
    welcomeGreeting: `Hi, I'm an AI assistant & not a person.`,
    parameters: { callId: 'abc-123' },
  })

  /**
   * §2.1: the disclosure is the first utterance, and the caller must not be
   * able to talk over it. `welcomeGreetingInterruptible` defaults to `any`,
   * so leaving it unset would let speech cut the disclosure off.
   */
  it('makes the disclosure the greeting and forbids interrupting it', () => {
    expect(twiml).toContain('welcomeGreeting="Hi, I&apos;m an AI assistant &amp; not a person."')
    expect(twiml).toContain('welcomeGreetingInterruptible="none"')
  })

  it('points at the socket and the action URL, and passes the call id through', () => {
    expect(twiml).toContain('url="wss://voice.example.com/relay"')
    expect(twiml).toContain('<Connect action="https://voice.example.com/twiml/action">')
    expect(twiml).toContain('<Parameter name="callId" value="abc-123"/>')
  })

  it('escapes everything it interpolates', () => {
    const t = sayAndHangupTwiml('5 > 3 & "quoted"')
    expect(t).toContain('5 &gt; 3 &amp; &quot;quoted&quot;')
    expect(t).toContain('<Hangup/>')
  })
})

describe('the handoff', () => {
  it('uses TaskRouter when a workflow is configured', () => {
    const t = handoffTwiml({ say: 'Connecting you.', taskRouterWorkflowSid: 'WW123', taskAttributes: { reason: 'asked' } })
    expect(t).toContain('<Enqueue workflowSid="WW123">')
    expect(t).toContain('&quot;reason&quot;')
  })

  it('falls back to dialling a person when there is no workflow', () => {
    const t = handoffTwiml({ say: 'Connecting you.', taskRouterWorkflowSid: null, dialNumber: '+14155550111', callerId: '+14155550100' })
    expect(t).toContain('<Dial callerId="+14155550100" timeout="25">+14155550111</Dial>')
    // And says something honest if nobody picks up, rather than silence.
    expect(t).toContain('Nobody was able to pick up')
  })

  /** Neither configured: say so and hang up, never pretend to transfer. */
  it('says nobody is available when there is nowhere to send them', () => {
    const t = handoffTwiml({ say: 'One moment.', taskRouterWorkflowSid: null, dialNumber: null })
    expect(t).toContain('Nobody is available right now')
    expect(t).toContain('<Hangup/>')
  })
})
