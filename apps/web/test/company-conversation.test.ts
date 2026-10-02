/**
 * The company page's Conversation panel, pinned by reading its source (the
 * page imports `@/auth`, so it cannot be imported here).
 *
 * Review round 3: /tasks withholds a LinkedIn step's words before Start and
 * again once the rules refuse — never sends them to the browser at all — and
 * this panel printed `t.body` for every touch of the company, the withheld
 * words one click away. The panel now asks `linkedinThreadWithheld`, which is
 * /tasks' own rule (tested against a real engine in
 * packages/db/test/linkedin-step.test.ts), and prints a pointer instead.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const page = code(read('../src/app/companies/[domain]/page.tsx'))
const panel = page.slice(page.indexOf('<h2>Conversation</h2>'))

describe('the Conversation panel', () => {
  it('asks the /tasks rule which LinkedIn words it may print', () => {
    expect(page).toMatch(/linkedinThreadWithheld\(db, user\.orgId, thread\)/)
  })

  it('prints a message’s words only where that rule holds nothing back', () => {
    // Every place the panel prints a body or a subject is behind the hold.
    const bodies = [...panel.matchAll(/\{t\.body\}/g)]
    expect(bodies).toHaveLength(1)
    const subjects = [...panel.matchAll(/\{t\.subject\}/g)]
    expect(subjects).toHaveLength(1)
    const held = panel.indexOf('withheld.get(t.id)')
    expect(held).toBeGreaterThan(-1)
    expect(held).toBeLessThan(panel.indexOf('{t.body}'))
    expect(held).toBeLessThan(panel.indexOf('{t.subject}'))
    // In their place, a line saying where the words are and why.
    expect(panel).toMatch(/linkedinHeldLine\(held, t\.status\)/)
    const words = page.slice(page.indexOf('function linkedinHeldLine'), page.indexOf('export default'))
    expect(words).toMatch(/shown in \/tasks when the rules allow/)
    expect(words).not.toMatch(/t\.body|\.body\b/)
  })
})
