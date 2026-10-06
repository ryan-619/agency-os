/**
 * Two create routes that wrote what an edit would refuse, or called every
 * fault a duplicate (found while the agent's tools were written over the same
 * functions, 2026-10-06). The routes import `@/auth`, so they are pinned by
 * reading their source, as this suite pins every route it cannot import.
 *
 * - POST /api/contacts stored a LinkedIn URL no profile could be read from:
 *   it gives no suppression key, so an opt-out recorded against the person's
 *   profile never matched them. It asks `linkedinIsReadable` first now, in
 *   the edit's words. (Its phone is normalised by `createContact` itself.)
 * - PATCH /api/campaigns/[id] answered a rename onto a taken name with a 500,
 *   and POST /api/campaigns called EVERY fault "already exists".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('POST /api/contacts', () => {
  const route = src('app/api/contacts/route.ts')

  it('refuses a LinkedIn URL no profile can be read from, before anything is written', () => {
    const check = route.indexOf('linkedinIsReadable(parsed.data.linkedinUrl)')
    const create = route.indexOf('createContact(db')
    expect(check).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(check)
    expect(route).toContain('linkedinUnreadable(parsed.data.linkedinUrl)')
  })
})

describe('the campaign routes', () => {
  it('PATCH answers a duplicate name with a 409 sentence, and logs any other fault by its class', () => {
    const route = src('app/api/campaigns/[id]/route.ts')
    expect(route).toContain('isUniqueViolation(err)')
    expect(route).toMatch(/already exists\. Nothing was saved\.`[\s\S]{0,40}status: 409/)
    expect(route).toContain("err instanceof Error ? err.name : 'UnknownError'")
  })

  it('POST calls only a unique violation a duplicate', () => {
    const route = src('app/api/campaigns/route.ts')
    expect(route).toContain('isUniqueViolation(err)')
    expect(route).not.toMatch(/\} catch \{\s*return NextResponse\.json\(\{ error: `A campaign called/)
    expect(route).toContain("err instanceof Error ? err.name : 'UnknownError'")
  })
})
