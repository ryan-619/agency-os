/**
 * `tools/remote-status.sh` hands node its whole program as ONE single-quoted
 * bash string (`node -e '…'`), so a single quote anywhere inside it — an
 * apostrophe in a comment, a quoted SQL literal — ends the string there.
 * bash then carries on reading the rest as shell, or silently drops the
 * quotes: the 0019 probe was written `to_regclass('message_templates')`, and
 * node received `to_regclass(message_templates)`, which Postgres refuses as
 * an unknown column — so the script stopped at that line, before the
 * heartbeat and the user count, every time it ran.
 *
 * This reads the program the way bash does and checks it is all of it: it
 * runs to the script's own closing quote, it parses as JavaScript, and every
 * migration probe passes its table name as a parameter.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = readFileSync(resolve(root, 'tools/remote-status.sh'), 'utf8')

/** The program as bash passes it to node: from `node -e '` to the very next single quote. */
function programAsBashSeesIt(): { program: string; rest: string } {
  const open = script.indexOf("node -e '")
  expect(open).toBeGreaterThan(-1)
  const start = open + "node -e '".length
  const end = script.indexOf("'", start)
  return { program: script.slice(start, end), rest: script.slice(end + 1) }
}

describe('tools/remote-status.sh', () => {
  it('hands node the whole program: no single quote inside it ends the string early', () => {
    const { program, rest } = programAsBashSeesIt()
    // What follows the closing quote is shell, and only a little of it.
    expect(program.trimEnd().endsWith('})')).toBe(true)
    expect(rest.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length).toBeLessThan(10)
  })

  it('parses as JavaScript', () => {
    const { program } = programAsBashSeesIt()
    // Compiled, never run: a syntax error throws here.
    expect(() => new vm.Script(`(async () => {\n${program}\n})`)).not.toThrow()
  })

  it('names each migration’s table as a parameter, never as a quoted literal', () => {
    const { program } = programAsBashSeesIt()
    // Every argument is a bind parameter, or the alias of an unnest over one.
    const args = [...program.matchAll(/to_regclass\(([^)]*)\)/g)].map((m) => m[1]!.trim())
    expect(args.length).toBeGreaterThanOrEqual(3)
    for (const arg of args) expect(['$1', 't'], arg).toContain(arg)
    for (const table of ['message_templates', 'assistant_settings']) {
      expect(program).toContain(`["${table}"]`)
    }
    expect(program).toContain('<- 0020 is applied')
    expect(program).toContain('<- 0021 is applied')
    expect(program).toContain('<- 0022 is applied')
    expect(program).toContain('<- 0023 is applied')
  })
})
