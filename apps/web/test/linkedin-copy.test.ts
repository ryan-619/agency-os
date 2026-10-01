/**
 * Nothing that queues a LinkedIn message says the worker will send it.
 *
 * The worker's one provider sends email, and `dueTouches` selects only the
 * provider's channels, so an approved or queued LinkedIn row is never picked
 * up by it. It becomes a step on /tasks that a person presses Start on and
 * sends from their own account. /approvals and campaign enrolment both said
 * otherwise — "the worker will send it on its next pass", "queued for the
 * worker to send", "these go to the worker without a person reading each
 * one" — and an approver who believed it never opened /tasks. Review round 3,
 * finding [19].
 *
 * Both components are client components that import through `@/`, so they
 * are read rather than rendered; the words themselves are pinned in
 * approval-view.test.ts, and here only that the components use them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
/** The prose as a person reads it: tags and line breaks collapsed. */
const proseOf = (src: string): string => src.replace(/<[^>]+>/g, '').replace(/\{' '\}/g, ' ').replace(/\s+/g, ' ')

describe('/approvals, for a LinkedIn draft', () => {
  const src = read('../src/components/outreach/drafts.tsx')

  it('says what approving did through approvedMessage, by the draft’s channel', () => {
    expect(src).toContain('approvedMessage(draft.channel, noSenderNote)')
    expect(src).not.toContain('The worker will send it on its next pass')
  })

  it('words the footnote by the draft’s channel', () => {
    expect(src).toContain('approveFootnote(noSenderNote, d.channel)')
  })

  it('shows the no-worker note above the queue only for drafts a worker would send', () => {
    expect(src).toMatch(/queueNoSenderNote\(\s*drafts\.map\(\(d\) => d\.channel\),\s*noSenderNote\s*\)/)
  })
})

describe('campaign enrolment, for a LinkedIn campaign', () => {
  const src = read('../src/components/outreach/campaigns.tsx')
  const panel = src.slice(src.indexOf('function EnrolPanel('))
  const prose = proseOf(panel)

  it('no longer says the worker sends what it queued, on any channel, without saying where LinkedIn goes', () => {
    expect(prose).not.toContain('No provider can send on LinkedIn; approved rows will wait for the LinkedIn step')
    expect(panel).toMatch(/linkedIn\s*\?/)
  })

  it('says a queued LinkedIn message is a step on /tasks a person sends from their own account', () => {
    expect(prose).toContain('as steps on /tasks for a person to send from their own LinkedIn account')
    expect(prose).toContain('every rule is checked again when they press Start')
  })

  it('says an auto-send LinkedIn campaign still has a person read and send each one', () => {
    expect(prose).toContain('LinkedIn has no automatic sender')
    expect(prose).toContain('a person reads each one and sends it from their own account')
  })

  it('says an approved LinkedIn draft becomes a /tasks step', () => {
    expect(prose).toContain('once approved, it becomes a step on /tasks')
  })

  it('does not show the no-worker note on a LinkedIn campaign', () => {
    expect(panel).toMatch(/const noSender =\s*noSenderNote && !linkedIn \?/)
  })
})
