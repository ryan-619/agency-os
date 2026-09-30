/**
 * A connector named `agency` from before 0018, at the routes (PROMPT.md §6).
 *
 * `packages/db/test/connector-legacy-name.test.ts` reproduces the refusal
 * against a real engine: the name CHECK 0018 added NOT VALID is evaluated on
 * every UPDATE, so every write to such a row fails. This pins that each
 * route that writes a connector answers it with the sentence and a 409
 * rather than a 500 — by reading the sources, because a route reaches
 * `server-only` through `@/auth` and cannot be imported here.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string): string => readFileSync(resolve(here, '../src/app/api/connectors', p), 'utf8')

/** The text between a call and the next `catch (err) {` block's end — the handler that guards it. */
function guards(source: string, call: string): string {
  const at = source.indexOf(call)
  expect(at, `${call} is gone`).toBeGreaterThan(-1)
  const tryAt = source.lastIndexOf('try {', at)
  expect(tryAt, `${call} is not inside a try`).toBeGreaterThan(-1)
  const catchAt = source.indexOf('} catch (err) {', at)
  expect(catchAt).toBeGreaterThan(at)
  return source.slice(catchAt, source.indexOf('\n  }\n', catchAt))
}

describe('every connector write answers the pre-0018 agency row with a sentence', () => {
  const item = read('[id]/route.ts')
  const credential = read('[id]/credential/route.ts')
  const probe = read('[id]/probe/route.ts')

  it.each([
    ['enable and disable', item, 'setConnectorEnabled(db,'],
    ['the tools an owner turned off', item, 'connectorToolsSetDisabled(db,'],
    ['re-entering the credential', credential, 'credentialsReplaceForConnector('],
  ])('%s: recognises the refusal and answers 409', (_what, source, call) => {
    const handler = guards(source, call)
    expect(handler).toContain('isLegacyAgencyConnectorRefusal(err)')
    expect(handler).toMatch(/LEGACY_AGENCY_CONNECTOR_MESSAGE \}, \{ status: 409 \}/)
  })

  /** The probe's record is written on the worker, which logs the failure and swallows it. */
  it('refuses to probe it, before asking the worker', () => {
    const refuse = probe.indexOf("row.name === 'agency'")
    expect(refuse).toBeGreaterThan(-1)
    expect(refuse).toBeLessThan(probe.indexOf('await probeConnector('))
    expect(probe.slice(refuse, refuse + 200)).toContain('LEGACY_AGENCY_CONNECTOR_MESSAGE')
  })

  /** The way out the sentence names: DELETE is not guarded, because a CHECK is not evaluated on it. */
  it('leaves DELETE as it was', () => {
    const del = item.slice(item.indexOf('export async function DELETE'))
    expect(del).toContain('await deleteConnector(db, user.orgId, id)')
    expect(del.slice(0, del.indexOf('async function authorise'))).not.toContain('isLegacyAgencyConnectorRefusal')
  })
})
