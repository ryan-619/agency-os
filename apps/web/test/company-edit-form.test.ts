/**
 * The company edit form's stage list is core's `COMPANY_STAGES`, restated for
 * the browser (0021). The form is a client module that imports `@/`, so it is
 * read as source rather than imported: a stage the server refuses must never
 * be offered, and one it takes must never be missing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMPANY_STAGES } from '@agency/core'

const source = readFileSync(
  fileURLToPath(new URL('../src/components/company/edit-form.tsx', import.meta.url)),
  'utf8',
)

describe('the company edit form', () => {
  it('offers exactly the stages the server accepts', () => {
    const block = source.slice(source.indexOf('export const STAGE_OPTIONS = ['), source.indexOf('] as const'))
    const offered = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(offered).toEqual([...COMPANY_STAGES])
  })

  it('sends a headcount as a number, and a blank as a clear', () => {
    expect(source).toMatch(/body\['headcount'\] = Number\(count\)/)
    expect(source).toMatch(/if \(count === ''\) body\['headcount'\] = null/)
  })
})
