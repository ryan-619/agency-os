/**
 * A stop whose recording threw, as every inbound email path reads it
 * (review round 6).
 *
 * The webhooks kept the recorder's rolled-back line and took the loud path
 * from it; the worker's IMAP inbox did not, and abandoned such a stop after
 * five attempts with log lines only. The reader of that line moved here so
 * the two share it, with the pause, the row and the alarm it leads to —
 * and the module stays pure, so the web bundle and the worker can both
 * import it without a second copy.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pauseReasonClass } from '@agency/core'
import * as q from '../src/queries.js'
import * as all from '../src/index.js'
import {
  keepingRolledBackOptOut, rolledBackOptOutAlarm, rolledBackOptOutAudit, rolledBackOptOutPauseReason,
  type InboundLog,
} from '../src/index.js'

const NOON = new Date('2026-09-15T12:00:00.000Z')
const PLACED = { orgId: 'org-1', contactId: 'contact-1', inReplyTo: 'touch-1' } as const

function forwardTo(lines: { message: string; fields?: Readonly<Record<string, unknown>> }[]): InboundLog {
  return { error: (message, fields) => lines.push({ message, ...(fields ? { fields } : {}) }) }
}

describe('keepingRolledBackOptOut', () => {
  it('forwards every line, and keeps only an opt-out that names an org and a contact', () => {
    const lines: { message: string; fields?: Readonly<Record<string, unknown>> }[] = []
    const recorder = keepingRolledBackOptOut(forwardTo(lines))
    recorder.error('something else', { orgId: 'org-1', contactId: 'contact-1' })
    expect(recorder.rolledBack()).toBeNull()
    recorder.error('OPT-OUT NOT RECORDED — the reply was rolled back', { orgId: 'org-1' })
    expect(recorder.rolledBack()).toBeNull()
    recorder.error('OPT-OUT NOT RECORDED — the reply was rolled back; a provider retry records it, otherwise follow up by hand', {
      contactId: 'contact-1', orgId: 'org-1', inReplyTo: 'touch-1', why: 'DatabaseError',
    })
    expect(recorder.rolledBack()).toEqual(PLACED)
    expect(lines.map((l) => l.message)).toEqual([
      'something else',
      'OPT-OUT NOT RECORDED — the reply was rolled back',
      'OPT-OUT NOT RECORDED — the reply was rolled back; a provider retry records it, otherwise follow up by hand',
    ])
  })

  it('reads a reply matched by its address alone as answering no message', () => {
    const recorder = keepingRolledBackOptOut(forwardTo([]))
    recorder.error('OPT-OUT NOT RECORDED — the reply was rolled back', { orgId: 'org-1', contactId: 'contact-1', inReplyTo: null })
    expect(recorder.rolledBack()).toEqual({ orgId: 'org-1', contactId: 'contact-1', inReplyTo: null })
  })
})

describe('what follows it', () => {
  it('pauses in words read as an opt-out nobody recorded — which no answer and no Resume lifts', () => {
    const reason = rolledBackOptOutPauseReason(NOON)
    expect(reason).toBe('opt-out not recorded: reply 2026-09-15T12:00:00.000Z (record_failed)')
    expect(pauseReasonClass(reason)).toBe('opt_out_not_recorded')
  })

  it('audits ids, the channel and a reason class', () => {
    expect(rolledBackOptOutAudit(PLACED)).toEqual({
      orgId: 'org-1',
      actor: 'system',
      action: 'contact.opt_out_not_recorded',
      subjectType: 'contact',
      subjectId: 'contact-1',
      detail: { channel: 'email', why: 'record_failed' },
    })
  })

  it('alarms naming the message the reply answered, or none', () => {
    expect(rolledBackOptOutAlarm(PLACED)).toEqual({
      kind: 'opt_out_not_recorded', orgId: 'org-1', touchId: 'touch-1', contactId: 'contact-1', path: 'reply',
    })
    expect(rolledBackOptOutAlarm({ ...PLACED, inReplyTo: null })).toMatchObject({ touchId: null, contactId: 'contact-1' })
  })
})

describe('the module', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'inbound-fault.ts'), 'utf8')

  it('is pure: it imports types only, and touches no database, clock or console', () => {
    const imports = [...src.matchAll(/^import\b[^\n]*$/gm)].map((m) => m[0])
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line, line).toMatch(/^import type /)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bnew Date\(|Date\.now\(|\bconsole\.|\bprocess\.|\bawait\b/)
  })

  it('is exported from both barrels — the web reaches it through queries, the worker through the root', () => {
    const queries = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'queries.ts'), 'utf8')
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
    expect(queries).toContain(`export * from './inbound-fault.js'`)
    expect(index).toContain(`export * from './inbound-fault.js'`)
    for (const name of ['keepingRolledBackOptOut', 'rolledBackOptOutPauseReason', 'rolledBackOptOutAudit', 'rolledBackOptOutAlarm']) {
      expect(name in q && name in all, name).toBe(true)
    }
  })
})
