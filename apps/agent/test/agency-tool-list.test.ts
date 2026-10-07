/**
 * The model can be shown every agency tool (2026-10-07).
 *
 * The CLI asks the in-process `agency` server for its tools, and the SDK
 * turns each tool's zod shape into JSON Schema inside that one answer. One
 * shape it could not convert — create_icp's `weights`, a `z.record` — made the
 * whole answer an error: in chat every agency tool was "No such tool
 * available", the model went on with the connectors alone, and no log line
 * said why. These tests list the REAL server through MCP's own transport, the
 * request the CLI makes, and show that the check can fail.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { AGENCY_TOOLS, type AgencyToolSpec } from '@agency/tools'
import { createLedger } from '../src/gate/ledger.js'
import {
  AGENCY_SERVER_INSTRUCTIONS, agencyToolsToOmit, createAgencyMcpServer, listServerTools, unlistableAgencyTools,
} from '../src/mcp/agency.js'

function inert(omit?: ReadonlySet<string>) {
  return {
    context: () => {
      throw new Error('no tool runs in a listing')
    },
    ledger: createLedger(),
    turnId: () => 'listing-test',
    onBypass: () => {},
    log: { error: () => {} },
    ...(omit ? { omit } : {}),
  }
}

const ALL_NAMES = AGENCY_TOOLS.map((spec) => spec.name).sort()

/** create_icp as it shipped: its weights a record, which the SDK cannot describe. */
function withTheRecordShape(): readonly AgencyToolSpec[] {
  return AGENCY_TOOLS.map((spec) =>
    spec.name === 'create_icp'
      ? ({ ...spec, shape: { ...spec.shape, weights: z.record(z.string().max(60), z.number().int()).optional() } } as AgencyToolSpec)
      : spec,
  )
}

function recordingLog() {
  const lines: Array<{ level: 'info' | 'error'; msg: string; fields?: Record<string, unknown> }> = []
  return {
    lines,
    info: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: 'info', msg, ...(fields ? { fields } : {}) }),
    error: (msg: string, fields?: Record<string, unknown>) => void lines.push({ level: 'error', msg, ...(fields ? { fields } : {}) }),
  }
}

describe('the agency tools the model is shown', () => {
  it('lists every agency tool, asked the way the CLI asks', async () => {
    const listing = await listServerTools(createAgencyMcpServer(inert()))
    expect(listing).toMatchObject({ ok: true })
    if (!listing.ok) return
    expect([...listing.names].sort()).toEqual(ALL_NAMES)
    expect(ALL_NAMES.length).toBeGreaterThanOrEqual(52)
    expect(await unlistableAgencyTools()).toEqual({ unlistable: [] })
  })

  it('loses EVERY tool to one shape the SDK cannot describe — which is why the worker asks', async () => {
    const specs = withTheRecordShape()
    const whole = createSdkMcpServer({
      name: 'agency',
      version: '1.0.0',
      tools: specs.map((spec) => tool(spec.name, spec.description, spec.shape, async () => ({ content: [] }))),
    })
    const listing = await listServerTools(whole)
    expect(listing.ok).toBe(false)

    // The check names the one at fault, and the rest list without it.
    expect(await unlistableAgencyTools(specs)).toEqual({ unlistable: ['create_icp'] })
  })

  it('leaves out only the tool that cannot be listed, and says so at error', async () => {
    const log = recordingLog()
    const omit = await agencyToolsToOmit(log, withTheRecordShape())
    expect([...omit]).toEqual(['create_icp'])
    expect(log.lines).toEqual([
      {
        level: 'error',
        msg: 'AGENCY TOOLS LEFT OUT — the model cannot be shown them, so every turn goes without them',
        fields: { leftOut: ['create_icp'], listed: ALL_NAMES.length - 1 },
      },
    ])

    const listing = await listServerTools(createAgencyMcpServer(inert(omit)))
    expect(listing.ok && [...listing.names].sort()).toEqual(ALL_NAMES.filter((name) => name !== 'create_icp'))
  })

  it('says at info when every tool can be shown, and leaves nothing out', async () => {
    const log = recordingLog()
    expect((await agencyToolsToOmit(log)).size).toBe(0)
    expect(log.lines).toEqual([
      { level: 'info', msg: 'agency tools: every one can be shown to the model', fields: { tools: ALL_NAMES.length } },
    ])
  })

  /**
   * The server's own words reach the model on every turn, beside the system
   * prompt, and they said every change asked a person — after the operator
   * decided (2026-10-06) that the team's own records change at once. A model
   * told both declines the work it was asked for.
   */
  it('tells the model what the gate does', () => {
    expect(AGENCY_SERVER_INSTRUCTIONS).toMatch(/changes to the team’s own records run at once/)
    expect(AGENCY_SERVER_INSTRUCTIONS).toMatch(/A person approves first/)
    expect(AGENCY_SERVER_INSTRUCTIONS).not.toMatch(/every change asks a person/)
  })
})
