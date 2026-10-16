/**
 * "Ask the assistant about this" (2026-10-09): the words a link carries are
 * bounded and name the record, never its people's details.
 */
import { describe, expect, it } from 'vitest'
import { ASK_MAX_CHARS, askAboutCompany, askAboutReply, askDraftFrom, askLink } from '../src/lib/ask-link'

describe('ask links', () => {
  it('rounds a trip through the query string, trimmed and bounded', () => {
    const link = askLink(askAboutCompany('kumardental.in', 'Kumar Dental'))
    expect(link.startsWith('/chat?ask=')).toBe(true)
    const param = decodeURIComponent(link.slice('/chat?ask='.length))
    expect(askDraftFrom(param)).toBe(askAboutCompany('kumardental.in', 'Kumar Dental'))
    expect(askDraftFrom('  hello  ')).toBe('hello')
    expect(askDraftFrom(['first', 'second'])).toBe('first')
    expect(askDraftFrom(undefined)).toBe('')
    expect(askDraftFrom('a'.repeat(ASK_MAX_CHARS + 50))).toHaveLength(ASK_MAX_CHARS)
    expect(askDraftFrom('bad\u0000chars\u0007here')).toBe('badcharshere')
  })

  it('names the record and nothing about its people', () => {
    expect(askAboutCompany('kumardental.in', null)).toContain('About kumardental.in:')
    expect(askAboutReply('kumardental.in', 'Kumar Dental')).toContain('A reply from Kumar Dental (kumardental.in) is waiting')
    expect(askAboutReply(null, null)).toContain('this company')
    expect(askAboutReply('kumardental.in', 'Kumar Dental')).toContain('without sending anything')
  })
})
