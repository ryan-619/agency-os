/**
 * The kickoff and renewal templates are data, and the data is the product:
 * the five things an engagement starts with and the two it ends with. The
 * titles are pinned as literals so that a change to what the agency asks a
 * person to do is a change somebody reads in a diff, not a side effect.
 */
import { describe, it, expect } from 'vitest'
import {
  KICKOFF_TEMPLATE, RENEWAL_TEMPLATE, TASK_TEMPLATES, isTaskTemplateName, tasksFromTemplate,
} from '../src/kickoff.js'

const DAY = 86_400_000
const FROM = new Date('2026-09-15T09:30:00.000Z')

describe('KICKOFF_TEMPLATE', () => {
  it('is the five tasks an engagement starts with, in order', () => {
    expect(KICKOFF_TEMPLATE.map((t) => t.title)).toEqual([
      'Signed authorisation letter on file',
      'Test accounts for each role in scope',
      'Source IPs on the client allow-list',
      'Escalation contacts agreed on both sides',
      'Out-of-band channel for credentials agreed',
    ])
    expect(KICKOFF_TEMPLATE.every((t) => t.kind === 'kickoff')).toBe(true)
  })

  it('is frozen, list and items', () => {
    expect(Object.isFrozen(KICKOFF_TEMPLATE)).toBe(true)
    expect(KICKOFF_TEMPLATE.every((t) => Object.isFrozen(t))).toBe(true)
    expect(() => (KICKOFF_TEMPLATE as unknown as unknown[]).push({})).toThrow()
  })
})

describe('RENEWAL_TEMPLATE', () => {
  it('is the retest at six weeks and the re-engagement at eleven months', () => {
    expect(RENEWAL_TEMPLATE.map((t) => [t.title, t.dueAfterDays])).toEqual([
      ['Retest the fixed findings', 42],
      ['Re-engagement conversation', 335],
    ])
    expect(RENEWAL_TEMPLATE.every((t) => t.kind === 'renewal')).toBe(true)
    expect(Object.isFrozen(RENEWAL_TEMPLATE)).toBe(true)
    expect(RENEWAL_TEMPLATE.every((t) => Object.isFrozen(t))).toBe(true)
  })
})

describe('every template entry', () => {
  it('fits the tasks table: a non-blank title of at most 200 characters, a positive whole number of days', () => {
    for (const t of [...KICKOFF_TEMPLATE, ...RENEWAL_TEMPLATE]) {
      expect(t.title.trim(), t.title).not.toBe('')
      expect(t.title.length, t.title).toBeLessThanOrEqual(200)
      expect(Number.isInteger(t.dueAfterDays) && t.dueAfterDays > 0, t.title).toBe(true)
      expect(t.detail.trim(), t.title).not.toBe('')
    }
  })

  it('never promises to send anything', () => {
    for (const t of [...KICKOFF_TEMPLATE, ...RENEWAL_TEMPLATE]) {
      expect(`${t.title} ${t.detail}`, t.title).not.toMatch(/\b(we will|will be) (send|sent|email)/i)
    }
  })
})

describe('TASK_TEMPLATES', () => {
  it('names exactly the two templates', () => {
    expect(Object.keys(TASK_TEMPLATES).sort()).toEqual(['kickoff', 'renewal'])
    expect(TASK_TEMPLATES.kickoff).toBe(KICKOFF_TEMPLATE)
    expect(TASK_TEMPLATES.renewal).toBe(RENEWAL_TEMPLATE)
    expect(isTaskTemplateName('kickoff')).toBe(true)
    expect(isTaskTemplateName('renewal')).toBe(true)
    expect(isTaskTemplateName('todo')).toBe(false)
    expect(isTaskTemplateName(undefined)).toBe(false)
  })
})

describe('tasksFromTemplate', () => {
  it('dates each task relative to the instant it is applied', () => {
    const tasks = tasksFromTemplate(KICKOFF_TEMPLATE, FROM)
    expect(tasks).toHaveLength(5)
    expect(tasks.map((t) => t.dueAt.toISOString())).toEqual([
      '2026-09-17T09:30:00.000Z',
      '2026-09-20T09:30:00.000Z',
      '2026-09-20T09:30:00.000Z',
      '2026-09-17T09:30:00.000Z',
      '2026-09-17T09:30:00.000Z',
    ])
    expect(tasks.map((t) => t.title)).toEqual(KICKOFF_TEMPLATE.map((t) => t.title))
    expect(tasks.every((t) => t.kind === 'kickoff')).toBe(true)
  })

  it('puts the renewal retest six weeks out and the re-engagement eleven months out', () => {
    const [retest, reengage] = tasksFromTemplate(RENEWAL_TEMPLATE, FROM)
    expect(retest!.dueAt.getTime() - FROM.getTime()).toBe(42 * DAY)
    expect(reengage!.dueAt.getTime() - FROM.getTime()).toBe(335 * DAY)
    expect(reengage!.dueAt.toISOString()).toBe('2027-08-16T09:30:00.000Z')
  })

  it('counts 24-hour steps on the instant, so a DST change does not move the time of day in UTC', () => {
    // Europe/London leaves summer time on 2026-10-25; the answer does not care.
    const [retest] = tasksFromTemplate(RENEWAL_TEMPLATE, new Date('2026-10-20T12:00:00.000Z'))
    expect(retest!.dueAt.toISOString()).toBe('2026-12-01T12:00:00.000Z')
  })

  it('is deterministic and does not share dates with the caller', () => {
    const a = tasksFromTemplate(KICKOFF_TEMPLATE, FROM)
    const b = tasksFromTemplate(KICKOFF_TEMPLATE, new Date(FROM.getTime()))
    expect(a).toEqual(b)
    a[0]!.dueAt.setTime(0)
    expect(tasksFromTemplate(KICKOFF_TEMPLATE, FROM)[0]!.dueAt.toISOString()).toBe('2026-09-17T09:30:00.000Z')
    expect(FROM.toISOString()).toBe('2026-09-15T09:30:00.000Z')
  })

  it('refuses an invalid instant rather than producing tasks due at NaN', () => {
    expect(() => tasksFromTemplate(KICKOFF_TEMPLATE, new Date('not a date'))).toThrow(RangeError)
  })
})
