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

  /**
   * The gate names a tool in full, and that is what reaches the card — in
   * chat and on /approvals. Keyed by the bare name, every agency card read
   * "Run queue_touch on the agency connector" until the prefix came off
   * (2026-10-15); the tests above pass bare names and could not see it.
   */
  it('reads an agency tool by its full name exactly as by its bare one', () => {
    const payload = { domain: 'kumardental.in', channel: 'email', subject: 'A note', body: 'Hi' }
    expect(describeApproval('mcp__agency__queue_touch', payload)).toEqual(describeApproval('queue_touch', payload))
    expect(describeApproval('mcp__agency__queue_touch', payload).title).toBe('Draft an email to kumardental.in for approval')
    expect(describeApproval('mcp__agency__resume_contact', { contactId: 'x', pausedFor: 'manual' }).title).toBe(
      'Resume a paused contact, so campaigns may write to them again',
    )
    // An agency tool with no title of its own is named bare, never as a connector.
    expect(describeApproval('mcp__agency__add_note', {}).title).toBe('Run add_note')
    // A key or a tool named after Object's own properties finds nothing of Object's.
    expect(describeApproval('mcp__agency__constructor', { toString: 'x' })).toEqual({
      title: 'Run constructor', message: null, facts: [{ label: 'toString', value: 'x' }],
    })
  })

  it('words a delete card: what goes, each item on its own line, and that it cannot be undone', () => {
    const people = describeApproval('mcp__agency__delete_contacts', {
      contacts: [
        { contactId: 'k1', name: 'Alex Chen', emailDomain: '…@carbonmaps.io' },
        { contactId: 'k2' },
      ],
      why: 'invented by the assistant to test the features',
    })
    expect(people.title).toBe('Delete 2 contacts from the CRM — it cannot be undone')
    expect(people.facts).toEqual([
      { label: 'People', value: '1. Alex Chen · email at carbonmaps.io · id k1\n2. (no name given) · id k2' },
      { label: 'Why', value: 'invented by the assistant to test the features' },
    ])

    expect(describeApproval('mcp__agency__delete_companies', { companies: [{ companyId: 'c1', domain: 'carbonmaps.io' }], why: 'x' }).title)
      .toBe('Delete company carbonmaps.io and everything filed under it — it cannot be undone')
    const two = describeApproval('mcp__agency__delete_companies', {
      companies: [{ companyId: 'c1', domain: 'a.io' }, { companyId: 'c2', domain: 'b.io' }],
    })
    expect(two.title).toBe('Delete 2 companies and everything filed under them — it cannot be undone')
    expect(two.facts[0]).toEqual({ label: 'Companies', value: '1. a.io · id c1\n2. b.io · id c2' })
    // A booking-page lead's placeholder is a person's address: never in the title.
    expect(describeApproval('mcp__agency__delete_companies', { companies: [{ companyId: 'c1', domain: 'ravi@gmail.com.inbound' }] }).title)
      .toBe('Delete 1 company and everything filed under it — it cannot be undone')

    expect(describeApproval('mcp__agency__delete_meeting', { meetingId: 'm1', domain: 'carbonmaps.io', why: 'x' })).toMatchObject({
      title: 'Delete a meeting with carbonmaps.io — it cannot be undone',
      facts: [{ label: 'Meeting (id)', value: 'm1' }, { label: 'Company', value: 'carbonmaps.io' }, { label: 'Why', value: 'x' }],
    })
    expect(describeApproval('mcp__agency__delete_task', { taskId: 't1', title: 'Call Alex Chen', why: 'x' }).title).toBe(
      'Delete the task “Call Alex Chen” — it cannot be undone',
    )
  })

  /**
   * The delete renderers are the delete tools' (review, 2026-10-15). Keyed by
   * the payload key alone, a connector's `contacts` or `companies` — Apollo
   * adding people to a sequence, a CRM creating a deal — read "(no name
   * given)" in place of the emails, names and ids being sent, on the card
   * that decides whether those people are reached.
   */
  it('prints a connector’s contacts and companies whole, whatever their shape', () => {
    const ids = describeApproval('mcp__apollo__add_to_sequence', { sequence_id: 'seq1', contacts: ['c_1', 'c_2'] })
    expect(ids.title).toBe('Run add_to_sequence on the apollo connector')
    expect(ids.facts).toEqual([
      { label: 'sequence_id', value: 'seq1' },
      { label: 'People', value: wordFor(['c_1', 'c_2']) },
    ])
    const people = [{ email: 'jo.bloggs@acme.com', first_name: 'Jo', sequence_id: 'seq_123' }]
    const created = describeApproval('mcp__apollo__create_contacts', { contacts: people })
    expect(created.facts).toEqual([{ label: 'People', value: wordFor(people) }])
    for (const shown of ['jo.bloggs@acme.com', 'Jo', 'seq_123']) expect(created.facts[0]!.value).toContain(shown)
    expect(created.facts[0]!.value).not.toContain('no name given')

    const companies = [{ id: '987', name: 'Acme Corp' }]
    const deal = describeApproval('mcp__hubspot__create_deal', { companies })
    expect(deal.facts).toEqual([{ label: 'Companies', value: wordFor(companies) }])
    expect(deal.facts[0]!.value).not.toContain('no domain given')
    // A connector's own `steps` is its own too.
    const steps = [{ wait: 3, action: 'email' }]
    expect(describeApproval('mcp__close__create_sequence', { steps }).facts).toEqual([{ label: 'Steps', value: wordFor(steps) }])
    // A connector named like an agency tool is still a connector.
    expect(describeApproval('mcp__crm__delete_contacts', { contacts: people }).facts[0]!.value).toBe(wordFor(people))
  })

  it('prints a delete item whole when it carries anything the line does not', () => {
    const odd = [{ contactId: 'k1', name: 'Alex Chen', email: 'security@carbonmaps.io' }]
    expect(describeApproval('mcp__agency__delete_contacts', { contacts: odd }).facts[0]!.value).toBe(wordFor(odd))
    const typed = [{ companyId: 'c1', domain: 42 }]
    expect(describeApproval('mcp__agency__delete_companies', { companies: typed }).facts[0]!.value).toBe(wordFor(typed))
  })

  it('words a value as a person reads it', () => {
    expect(wordFor(null)).toBe('(none)')
    expect(wordFor(false)).toBe('no')
    expect(wordFor(3)).toBe('3')
    expect(wordFor(['a'])).toBe('[\n  "a"\n]')
  })
})
