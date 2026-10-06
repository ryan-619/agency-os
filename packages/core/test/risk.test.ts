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
  classifyRisk, parseToolName, type Risk, type RiskRule,
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
  it('has exactly two tools that leave the building, and both are high', () => {
    const leaving = AGENCY_TOOL_NAMES.filter((n) => AGENCY_TOOL_RISK[n][1] === 'leaves_the_building')
    expect(leaving).toEqual(['queue_touch', 'enrol_contacts'])
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
    expect(AGENCY_TOOL_NAMES).toHaveLength(23 + 26)
  })

  it('never lets a write run without a person: every non-read tool but the scans is medium or high', () => {
    const scans = new Set(['scan_company', 'score_company', 'rescan_stale'])
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
