/**
 * The LinkedIn steps on /tasks, pinned by reading their source: the client
 * component imports `@/`, and the page is `server-only`, so neither can be
 * imported here (see CLAUDE.md, "a module a test imports carries no
 * `server-only` and no `@/` import").
 *
 * Two review findings, each a line that looked fine:
 *
 *  - The component compared `scheduledFor` with `Date.now()` while rendering.
 *    The server's render and the browser's hydration read two clocks, and a
 *    deferral that ended between them rendered on one side only — a React
 *    hydration error. The page now decides `deferred` on the server.
 *  - A handed step said "Every rule passed." for as long as it stayed open.
 *    That was true when Start was pressed and not necessarily since, so the
 *    sentence now says when, and the server re-checks the rules on every read
 *    (`linkedinStepsDue`, tested against a real engine in packages/db).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
/** The source without comments, so a sentence ABOUT `Date.now()` does not count as a call. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const component = read('../src/components/tasks/linkedin-steps.tsx')
const page = read('../src/app/tasks/page.tsx')

describe('the LinkedIn steps', () => {
  it('reads no clock while rendering: whether a deferral is ahead comes from the server', () => {
    expect(code(component)).not.toMatch(/Date\.now\(|new Date\(|Date\.parse\(/)
    expect(code(component)).toMatch(/step\.deferred/)
    // The page's `stepItem` passes the server's answer through.
    expect(code(page)).toMatch(/deferred: step\.deferred/)
  })

  it('never says "Every rule passed" without saying when they were checked', () => {
    expect(code(component)).not.toMatch(/Every rule passed\./)
    expect(code(component)).toMatch(/Every rule passed when/)
  })

  it('has a way to say what happened when the words are withheld, and the words the brief decided', () => {
    // A withheld step still offers both answers: the person may have sent it.
    const withheldBlock = code(component).slice(code(component).indexOf("state === 'handed' && !handed"))
    expect(withheldBlock).toMatch(/act\('sent'\)/)
    expect(withheldBlock).toMatch(/act\('not_sent'\)/)
    expect(code(page)).toMatch(/Handed over more than a day ago; the rules were checked then, not now/)
  })
})
