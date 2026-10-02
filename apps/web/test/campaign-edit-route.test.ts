/**
 * The campaign edit route and form, pinned by reading their source (review
 * round 3, findings 2 and 13). The route imports `server-only` modules, so a
 * test cannot import it; the behaviour itself is proved against a real
 * engine in packages/db/test/campaign-edit-guards.test.ts, and this keeps
 * the route and the form wired to it.
 *
 *  - The form sends the status it LOADED as `expectStatus`, so a save built
 *    on a stale read cannot re-activate a campaign the worker paused for
 *    bouncing while the form was open.
 *  - The route parses it, hands it to `updateCampaign` as an expected value,
 *    and answers every refusal but `not_found` with a 409 sentence — never a
 *    500, and never a silent write.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
/** Comments stripped, so a sentence about the code cannot satisfy a pin on the code. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the campaign edit route', () => {
  const route = code(read('../src/app/api/campaigns/[id]/route.ts'))

  it('parses the edit input, which carries the status the form loaded', () => {
    expect(route).toContain('campaignEditInput.safeParse(body)')
    expect(route).not.toContain('campaignInput.safeParse(body)')
    expect(route).toMatch(/const \{ expectStatus, \.\.\.input \} = parsed\.data/)
  })

  it('puts the loaded status and the read auto-send in updateCampaign’s predicate', () => {
    expect(route).toMatch(/updateCampaign\(db, user\.orgId, id, input, \{\s*autoSend: mayToggle \? null : current\.autoSend,\s*status: expectStatus \?\? null,\s*\}\)/)
  })

  it('answers not_found with a 404 and every other refusal with a 409 sentence', () => {
    expect(route).toMatch(/saved\.reason === 'not_found'\) return NextResponse\.json\(\{ error: 'No such campaign\.' \}, \{ status: 404 \}\)/)
    expect(route).toContain("return NextResponse.json({ error: refusedSave(saved) }, { status: 409 })")
    for (const reason of ['auto_send_changed', 'status_changed', 'channel_has_live_messages', 'changed']) {
      expect(route, reason).toContain(`case '${reason}':`)
    }
  })

  it('writes the audit row from the row the save returned', () => {
    expect(route).toContain('const updated = saved.row')
  })
})

describe('the campaign form', () => {
  const form = code(read('../src/components/outreach/campaigns.tsx'))

  it('sends the status it loaded on an edit, and nothing extra on a create', () => {
    expect(form).toContain('...(campaign ? { expectStatus: campaign.status } : {})')
  })
})
