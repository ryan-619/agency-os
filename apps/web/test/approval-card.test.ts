/**
 * The readable approval card (2026-10-09): a title, the message's words,
 * and every key as a fact — nothing dropped, so the reading never says less
 * than the JSON beside it.
 */
import { describe, expect, it } from 'vitest'
import { describeApproval, wordFor } from '../src/lib/approval-card'

describe('describeApproval', () => {
  it('reads an email draft as a message to a company, with the rest as facts', () => {
    const r = describeApproval('queue_touch', { domain: 'kumardental.in', channel: 'email', subject: 'A note', body: 'Hi Ravi,\n\nA look at your pages…' })
    expect(r.title).toBe('Draft an email to kumardental.in for approval')
    expect(r.message).toEqual({ subject: 'A note', body: 'Hi Ravi,\n\nA look at your pages…' })
    expect(r.facts).toEqual([{ label: 'Company', value: 'kumardental.in' }, { label: 'Channel', value: 'email' }])
  })

  it('shows every key, labelled by name when it has no words of its own, and never drops one', () => {
    const r = describeApproval('enrol_contacts', { campaignId: 'c1', dryRun: true, limit: 20, oddKey: { nested: 1 } })
    expect(r.title).toBe('Enrol contacts in a campaign (dry run — drafts nothing)')
    expect(r.message).toBeNull()
    expect(r.facts.map((f) => f.label)).toEqual(['Campaign (id)', 'Dry run', 'At most', 'oddKey'])
    expect(r.facts[1]!.value).toBe('yes')
    expect(r.facts[3]!.value).toBe('{\n  "nested": 1\n}')
  })

  it('words a campaign set active, a resume, a profile and a sequence’s steps', () => {
    expect(describeApproval('update_campaign', { campaignId: 'c1', status: 'active', statusRead: 'paused' }).title).toContain('Set a campaign active')
    expect(describeApproval('update_campaign', { campaignId: 'c1', dailyCap: 10 }).title).toBe('Change a campaign')
    expect(describeApproval('resume_contact', { contactId: 'x', pausedFor: 'replied' }).facts).toEqual([
      { label: 'Contact (id)', value: 'x' }, { label: 'The pause it lifts', value: 'replied' },
    ])
    expect(describeApproval('activate_icp', { name: 'SaaS India' }).title).toBe('Make “SaaS India” the active scoring profile')
    const steps = describeApproval('set_campaign_steps', {
      campaignId: 'c1', steps: [{ kind: 'message', afterDays: 3, body: 'Just checking in.' }, { kind: 'call', afterDays: 7 }],
    })
    expect(steps.facts.find((f) => f.label === 'Steps')!.value).toBe('2. message, 3 days later: “Just checking in.”\n3. call, 7 days later')
  })

  it('names a connector’s tool, and falls back to the tool name for anything else', () => {
    expect(describeApproval('mcp__apollo__people_search', { q: 'dentists' })).toEqual({
      title: 'Run people_search on the apollo connector', message: null, facts: [{ label: 'q', value: 'dentists' }],
    })
    expect(describeApproval('some_tool', 'raw').facts).toEqual([{ label: 'input', value: 'raw' }])
    expect(describeApproval('some_tool', null)).toEqual({ title: 'Run some_tool', message: null, facts: [] })
  })

  it('words a value as a person reads it', () => {
    expect(wordFor(null)).toBe('(none)')
    expect(wordFor(false)).toBe('no')
    expect(wordFor(3)).toBe('3')
    expect(wordFor(['a'])).toBe('[\n  "a"\n]')
  })
})
