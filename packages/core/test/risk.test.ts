/**
 * The approval gate's decision, one branch at a time.
 *
 * PROMPT.md §2.4 makes this the thing standing between an agent and an action
 * that leaves the building, and §6 makes it certain the classifier will be
 * handed tool names nobody has ever seen — new MCP servers are added from
 * inside the running product. So the property that matters most is not that
 * the known tools classify correctly; it is that there is NO input for which
 * the answer comes out permissive by accident.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENCY_TOOL_NAMES, AGENCY_TOOL_RISK, PERMITTED_TOOLS,
  classifyRisk, parseToolName, runsWithoutApproval, type Risk, type RiskRule,
} from '../src/risk.js'

const call = (toolName: string, input: Record<string, unknown> = {}) =>
  classifyRisk({ toolName, input })

describe('parseToolName', () => {
  it.each([
    ['mcp__agency__get_icp', 'agency', 'agency', 'get_icp'],
    ['mcp__apollo__search', 'connector', 'apollo', 'search'],
    ['mcp__a__b', 'connector', 'a', 'b'],
    ['Bash', 'builtin', null, 'Bash'],
    ['Agent', 'delegation', null, 'Agent'],
    ['Task', 'delegation', null, 'Task'],
  ])('%s is %s', (name, source, server, bare) => {
    expect(parseToolName(name)).toEqual({ source, serverName: server, bareName: bare })
  })

  it.each(['', 'mcp__', 'mcp__a', 'mcp__a__b__c', 'mcp____x', 'mcp__A__b', 'mcp__-a__b', 'mcp__a__'])(
    'refuses to guess at %j',
    (name) => {
      expect(parseToolName(name).source).toBe('malformed')
    },
  )

  it('never throws, whatever it is handed', () => {
    const hostile = ['\t', '\n', 'mcp__'.repeat(50), 'mcp__agency__a__b', '../../etc/passwd', ' ']
    for (const name of hostile) {
      expect(() => parseToolName(name), JSON.stringify(name)).not.toThrow()
    }
  })
})

describe('the branches, in order', () => {
  it('1. refuses a name it cannot parse', () => {
    expect(call('mcp__a__b__c')).toMatchObject({ risk: 'high', rule: 'malformed_name', refuse: true })
  })

  /**
   * §2.1 and §12: cold voice and SMS must not be reachable through any code
   * path, "including just for testing". High alone would only OFFER it to a
   * human, and an owner at the end of a long day can click approve — after
   * which a cold-SMS row is sitting in the table Phase 4's sender reads.
   */
  it.each(['sms', 'voice', 'whatsapp', 'SMS', 'Voice'])(
    '2. refuses channel %j outright, on any tool, with no human asked',
    (channel) => {
      for (const tool of ['mcp__agency__queue_touch', 'mcp__agency__get_icp', 'mcp__apollo__send']) {
        const v = call(tool, { channel })
        expect(v.rule, tool).toBe('forbidden_channel')
        expect(v.refuse, tool).toBe(true)
      }
    },
  )

  it('2. sees through padding and casing rather than matching the string exactly', () => {
    expect(call('mcp__agency__queue_touch', { channel: '  SMS  ' }).refuse).toBe(true)
  })

  it('2. still permits the channels cold outreach may use', () => {
    expect(call('mcp__agency__queue_touch', { channel: 'email' }).rule).toBe('leaves_the_building')
    expect(call('mcp__agency__queue_touch', { channel: 'linkedin' }).rule).toBe('leaves_the_building')
  })

  it.each(['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Skill', 'Glob', 'Grep'])(
    '3. refuses the built-in %s',
    (tool) => {
      expect(call(tool)).toMatchObject({ risk: 'high', rule: 'forbidden_tool', refuse: true })
    },
  )

  it('4. calls delegation medium, and does not refuse it', () => {
    for (const tool of ['Agent', 'Task']) {
      expect(call(tool)).toMatchObject({ risk: 'medium', rule: 'delegation', refuse: false })
    }
  })

  it('5. classifies every registered agency tool as the registry says', () => {
    for (const name of AGENCY_TOOL_NAMES) {
      const [risk, rule] = AGENCY_TOOL_RISK[name]
      const v = call(`mcp__agency__${name}`)
      expect(v.risk, name).toBe(risk)
      expect(v.rule, name).toBe(rule)
      expect(v.refuse, name).toBe(false)
    }
  })

  it('6. refuses an agency tool nobody classified', () => {
    expect(call('mcp__agency__delete_everything')).toMatchObject({
      risk: 'high', rule: 'unregistered_tool', refuse: true,
    })
  })

  /**
   * A connector is usable — a registry of servers nobody may call is a
   * registry that does nothing — but every call needs a human until someone
   * reviews it. That friction is the point, and it is exactly what makes the
   * allowedTools shortcut tempting. See CLAUDE.md on why that shortcut is a
   * gate bypass rather than a convenience.
   */
  it('7. sends an unreviewed connector to a human rather than refusing it', () => {
    expect(call('mcp__apollo__search_people', { q: 'x' })).toMatchObject({
      risk: 'high', rule: 'connector_unreviewed', refuse: false,
    })
  })

  it('8. fails closed on anything else', () => {
    expect(call('SomeToolInventedByAnSdkUpgrade')).toMatchObject({
      risk: 'high', rule: 'unregistered_tool', refuse: true,
    })
  })
})

describe('the properties that have to hold for every input', () => {
  const inputs = [
    '', '\t', 'Bash', 'Agent', 'mcp__agency__get_icp', 'mcp__agency__nope', 'mcp__x__y',
    'mcp__a__b__c', 'WebFetch', 'Unknown', 'mcp__A__b', 'mcp__agency__queue_touch',
  ]

  it('always returns a verdict and never throws', () => {
    for (const name of inputs) {
      expect(() => call(name), JSON.stringify(name)).not.toThrow()
      const v = call(name)
      expect(['low', 'medium', 'high'], name).toContain(v.risk)
      expect(v.explain.length, name).toBeGreaterThan(0)
    }
  })

  it('never explains a call by quoting its input — the explain line is shown to a human AND logged', () => {
    const secret = 'sk-live-must-not-appear'
    for (const name of inputs) {
      const v = call(name, { apiKey: secret, token: secret, channel: secret })
      expect(v.explain, name).not.toContain(secret)
    }
  })

  it('only ever says low for a tool in the registry', () => {
    for (const name of inputs) {
      const v = call(name)
      if (v.risk !== 'low') continue
      expect(PERMITTED_TOOLS.has(name), `${name} classified low but is not an agency tool`).toBe(true)
    }
  })

  it('refuses everything it does not positively recognise', () => {
    // The set of things that get a verdict other than "refuse" is short and
    // deliberate. Anything else turning up here is a gap, not a surprise.
    const notRefused = inputs.filter((n) => !call(n).refuse)
    expect(notRefused.sort()).toEqual(
      ['Agent', 'mcp__agency__get_icp', 'mcp__agency__queue_touch', 'mcp__x__y'].sort(),
    )
  })
})

describe('the registry cannot drift from what is reachable', () => {
  it('derives PERMITTED_TOOLS from the risk table rather than listing it twice', () => {
    expect([...PERMITTED_TOOLS].sort()).toEqual(
      AGENCY_TOOL_NAMES.map((n) => `mcp__agency__${n}`).sort(),
    )
  })

  /**
   * Two tools draft words for somebody outside the company: `queue_touch`,
   * one message, and `enrol_contacts`, an opener per person. Both are high,
   * so a person approves the call before any draft exists — and every draft
   * still waits on /approvals before anything is sent.
   */
  it('has exactly three tools that leave the building, and all are high', () => {
    const leaving = AGENCY_TOOL_NAMES.filter((n) => AGENCY_TOOL_RISK[n][1] === 'leaves_the_building')
    // `edit_draft` (2026-10-08) rewrites words to somebody outside: a queued
    // auto-send email would go with them unread, so it is carded like a draft.
    expect(leaving).toEqual(['queue_touch', 'enrol_contacts', 'edit_draft'])
    for (const name of leaving) expect(AGENCY_TOOL_RISK[name][0], name).toBe('high')
  })

  /**
   * The fourteen tools of the enhancement. Every read is low; every internal
   * write is medium; none of them leaves the building, which the test above
   * pins to `queue_touch` alone.
   */
  it('classifies every new read as low and every new internal write as medium', () => {
    const reads = [
      'check_send', 'get_consent', 'get_replies', 'get_scan_history', 'get_evidence_changes',
      'get_stale_companies', 'get_pipeline_metrics', 'get_company_timeline', 'get_compliance_summary',
      'search_crm', 'list_tasks',
    ] as const
    const writes = ['classify_reply', 'add_note', 'create_task'] as const
    for (const name of reads) {
      expect(AGENCY_TOOL_RISK[name][0], name).toBe('low')
      expect(AGENCY_TOOL_RISK[name][1], name).toBe('read_only')
    }
    for (const name of writes) {
      expect(AGENCY_TOOL_RISK[name][0], name).toBe('medium')
      expect(AGENCY_TOOL_RISK[name][1], name).toBe('writes_internal_state')
    }
    expect(reads.length + writes.length).toBe(14)
  })

  /**
   * The operator's tools (2026-10-06): what chat needs to run the CRM,
   * campaigns, the pipeline and the worker. Reads are low; an internal write
   * is medium; the scan of a few stale companies is low like `scan_company`;
   * drafting openers and lifting a pause are high. None of the internal
   * writes is low — every one of them still raises a card.
   */
  it('classifies the operator tools: reads low, internal writes medium, outreach and resume high', () => {
    const reads = [
      'list_contacts', 'list_campaigns', 'list_drafts', 'get_proposal', 'list_meetings',
      'worker_status', 'recent_errors', 'queue_status',
    ] as const
    const writes = [
      'add_company', 'update_company', 'import_companies', 'add_contact', 'update_contact', 'pause_contact',
      'add_suppression', 'create_campaign', 'update_campaign', 'generate_proposal', 'reschedule_meeting',
      'cancel_meeting', 'record_meeting_outcome', 'set_deal_owner', 'complete_task',
    ] as const
    for (const name of reads) {
      expect(AGENCY_TOOL_RISK[name][0], name).toBe('low')
      expect(AGENCY_TOOL_RISK[name][1], name).toBe('read_only')
    }
    for (const name of writes) {
      expect(AGENCY_TOOL_RISK[name][0], name).toBe('medium')
      expect(AGENCY_TOOL_RISK[name][1], name).toBe('writes_internal_state')
    }
    expect(AGENCY_TOOL_RISK.rescan_stale).toEqual([
      'low', 'derived_write', AGENCY_TOOL_RISK.rescan_stale[2],
    ])
    expect(AGENCY_TOOL_RISK.enrol_contacts.slice(0, 2)).toEqual(['high', 'leaves_the_building'])
    expect(AGENCY_TOOL_RISK.resume_contact.slice(0, 2)).toEqual(['high', 'reopens_outreach'])
    expect(reads.length + writes.length + 3).toBe(26)
    // The profiles (0021): a read, an internal write that stores an inactive
    // profile, and the switch, which changes how every later scan is scored.
    expect(AGENCY_TOOL_RISK.list_icps.slice(0, 2)).toEqual(['low', 'read_only'])
    expect(AGENCY_TOOL_RISK.create_icp.slice(0, 2)).toEqual(['medium', 'writes_internal_state'])
    expect(AGENCY_TOOL_RISK.activate_icp.slice(0, 2)).toEqual(['medium', 'changes_scoring'])
    // Editing a draft (2026-10-08): a read and a carded rewrite.
    expect(AGENCY_TOOL_RISK.get_draft.slice(0, 2)).toEqual(['low', 'read_only'])
    expect(AGENCY_TOOL_RISK.edit_draft.slice(0, 2)).toEqual(['high', 'leaves_the_building'])
    // Finding businesses and what they need (2026-10-08): four reads and one internal write.
    for (const read of ['find_businesses', 'get_opportunities', 'list_services'] as const) {
      expect(AGENCY_TOOL_RISK[read].slice(0, 2), read).toEqual(['low', 'read_only'])
    }
    expect(AGENCY_TOOL_RISK.audit_website.slice(0, 2)).toEqual(['low', 'derived_write'])
    expect(AGENCY_TOOL_RISK.add_businesses.slice(0, 2)).toEqual(['medium', 'writes_internal_state'])
    expect(AGENCY_TOOL_NAMES).toHaveLength(23 + 26 + 3 + 2 + 5)
  })

  it('never lets a write run without a person: every non-read tool but the scans is medium or high', () => {
    // audit_website (2026-10-08) records what Google's PageSpeed measured, as a scan records what it read.
    const scans = new Set(['scan_company', 'score_company', 'rescan_stale', 'audit_website'])
    for (const name of AGENCY_TOOL_NAMES) {
      const [risk, rule] = AGENCY_TOOL_RISK[name]
      if (rule === 'read_only' || scans.has(name)) continue
      expect(risk, name).not.toBe('low')
    }
  })

  it('gives every registered tool an explanation a human could act on', () => {
    for (const name of AGENCY_TOOL_NAMES) {
      const [, , explain] = AGENCY_TOOL_RISK[name] as readonly [Risk, RiskRule, string]
      expect(explain.length, name).toBeGreaterThan(20)
      expect(explain.endsWith('.'), name).toBe(true)
    }
  })
})

/**
 * Which calls run without a person deciding first (operator decision,
 * 2026-10-06: internal writes run at once). The line is drawn by RULE, and
 * these tests walk every agency tool through the REAL classifier, so a tool
 * added or reclassified later lands on a side of the line somebody chose.
 */
describe('runsWithoutApproval', () => {
  const verdictFor = (name: string) => call(`mcp__agency__${name}`)

  it('runs every read, derived write and internal write at once', () => {
    for (const name of AGENCY_TOOL_NAMES) {
      const v = verdictFor(name)
      if (['read_only', 'derived_write', 'writes_internal_state'].includes(v.rule)) {
        expect(runsWithoutApproval(v), name).toBe(true)
      }
    }
  })

  /**
   * The tripwire. Adding a tool that reaches a person — or reclassifying one —
   * changes this list, and this test then fails until somebody decides on
   * purpose which side of the line it belongs on.
   */
  it('keeps a card on exactly the agency tools that reach a person, lift a pause or change how scans are scored', () => {
    const carded = AGENCY_TOOL_NAMES.filter((name) => !runsWithoutApproval(verdictFor(name))).sort()
    expect(carded).toEqual(['activate_icp', 'edit_draft', 'enrol_contacts', 'queue_touch', 'resume_contact'])
  })

  /**
   * The one internal write that can open outreach rather than record it:
   * a campaign set active again releases messages a person approved and
   * then held by pausing it. Read from the call's input, so the tripwire
   * above — which asks with none — does not list it.
   */
  it('keeps a card on update_campaign only when it sets a campaign active', () => {
    const active = call('mcp__agency__update_campaign', { campaignId: 'c-1', status: 'active' })
    expect(active).toMatchObject({ risk: 'high', rule: 'reopens_outreach', refuse: false })
    expect(runsWithoutApproval(active)).toBe(false)
    for (const input of [
      { campaignId: 'c-1', status: 'paused' },
      { campaignId: 'c-1', status: 'done' },
      { campaignId: 'c-1', name: 'Q4 follow-ups' },
      { campaignId: 'c-1', dailyCap: 10, quietStart: '20:00' },
    ]) {
      const v = call('mcp__agency__update_campaign', input)
      expect(v.rule, JSON.stringify(input)).toBe('writes_internal_state')
      expect(runsWithoutApproval(v), JSON.stringify(input)).toBe(true)
    }
    // Setting a NEW campaign active opens nothing: it holds no messages, and
    // filling it is enrol_contacts, which keeps its card.
    expect(runsWithoutApproval(call('mcp__agency__create_campaign', { name: 'New', channel: 'email', status: 'active' }))).toBe(true)
  })

  it('runs the two internal writes that can only STOP outreach', () => {
    // Protective writes. Slowing an agent down from recording "leave me
    // alone" is the wrong direction to be cautious in.
    expect(runsWithoutApproval(verdictFor('add_suppression'))).toBe(true)
    expect(runsWithoutApproval(verdictFor('pause_contact'))).toBe(true)
  })

  it('keeps a card on any third-party connector tool, whatever it is called', () => {
    for (const name of ['mcp__zapier__send_email', 'mcp__hubspot__create_note', 'mcp__deepwiki__ask_question']) {
      const v = call(name)
      expect(v.rule).toBe('connector_unreviewed')
      expect(runsWithoutApproval(v), name).toBe(false)
    }
  })

  it('keeps a card on delegation, which writes nothing itself but spends', () => {
    const v = call('Agent', { description: 'research', prompt: 'look into acme', subagent_type: 'researcher' })
    expect(v.rule).toBe('delegation')
    expect(runsWithoutApproval(v)).toBe(false)
  })

  it('never runs a refused call, even one that names an internal-write rule', () => {
    expect(runsWithoutApproval({ risk: 'medium', rule: 'writes_internal_state', explain: 'x', refuse: true })).toBe(false)
    // And the real refusals the classifier makes stay refused.
    expect(runsWithoutApproval(call('Bash', { command: 'ls' }))).toBe(false)
    expect(runsWithoutApproval(call('mcp__agency__queue_touch', { channel: 'sms', body: 'hi' }))).toBe(false)
    expect(runsWithoutApproval(call('mcp__agency__not_a_real_tool'))).toBe(false)
  })
})
