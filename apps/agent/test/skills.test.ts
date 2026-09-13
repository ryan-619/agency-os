/**
 * Skills, and the gate bypass they need (PROMPT.md §6).
 *
 * Skills are the one §6 feature that genuinely requires opening one of the
 * three documented ways `canUseTool` is skipped. That was MEASURED, against a
 * scratch directory holding one SKILL.md:
 *
 *     settingSources: []          49 commands, pipeline-review present: false
 *     settingSources: ['project'] 50 commands, pipeline-review present: true
 *
 * So the feature costs the project setting source, and the SDK warns that
 * *"Allow rules from settings files can also shadow the callback but are not
 * visible here."*
 *
 * What makes it acceptable is that the bypass lives in the FILES, not in the
 * skills — a skill is markdown, and everything it makes the model DO still
 * arrives at `canUseTool`. So the worker refuses to load skills from a
 * directory that contains anything able to carry a permission rule, and these
 * tests are that refusal, one forbidden file at a time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSkillsRoot, readSkillSummary } from '../src/runtime/skills.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agency-skills-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function addSkill(name: string, front = `name: ${name}\ndescription: A skill for ${name}.`): void {
  const dir = join(root, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${front}\n---\n\nDo the thing.\n`)
}

describe('off by default', () => {
  /**
   * A deployment that does not use skills must not carry the setting source
   * at all. Empty is not the same as omitted: the SDK loads EVERY source when
   * `settingSources` is omitted.
   */
  it('loads nothing, and no setting source, when the variable is unset', () => {
    const d = inspectSkillsRoot(undefined)
    expect(d.status).toBe('off')
    expect(d.settingSources).toEqual([])
    expect(d.skills).toBeUndefined()
  })

  it('does not take the setting source for an empty skills directory', () => {
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true })
    const d = inspectSkillsRoot(root)
    expect(d.status).toBe('off')
    expect(d.settingSources).toEqual([])
  })
})

describe('a volume that holds only skills', () => {
  it('turns them on, with the project source and nothing else', () => {
    addSkill('pipeline-review')
    const d = inspectSkillsRoot(root)
    expect(d.status).toBe('on')
    expect(d.settingSources).toEqual(['project'])
    expect(d.skills).toBe('all')
    expect(d.names).toEqual(['pipeline-review'])
  })

  it('finds several, in a stable order', () => {
    addSkill('zeta')
    addSkill('alpha')
    expect(inspectSkillsRoot(root).names).toEqual(['alpha', 'zeta'])
  })

  it('ignores a directory with no SKILL.md, and a loose file', () => {
    addSkill('real')
    mkdirSync(join(root, '.claude', 'skills', 'not-a-skill'), { recursive: true })
    writeFileSync(join(root, '.claude', 'skills', 'README.md'), 'notes')
    expect(inspectSkillsRoot(root).names).toEqual(['real'])
  })
})

describe('a volume that could shadow the gate', () => {
  /**
   * THE tests. Each of these files is read by `settingSources: ['project']`
   * and each can carry a permission rule, an agent definition, or a hook —
   * any of which reaches the model without the approval queue.
   */
  it.each([
    'settings.json',
    'settings.local.json',
    'mcp.json',
  ])('refuses when .claude/%s exists, and names the file', (file) => {
    addSkill('pipeline-review')
    writeFileSync(join(root, '.claude', file), '{"permissions":{"allow":["Bash"]}}')
    const d = inspectSkillsRoot(root)
    expect(d.status).toBe('refused')
    expect(d.settingSources).toEqual([])
    expect(d.skills).toBeUndefined()
    expect(d.reason).toContain(file)
    // The refusal has to say what to do about it.
    expect(d.reason).toMatch(/Remove it, or/)
  })

  it.each(['agents', 'commands', 'hooks', 'plugins'])(
    'refuses when .claude/%s/ exists',
    (dir) => {
      addSkill('pipeline-review')
      mkdirSync(join(root, '.claude', dir), { recursive: true })
      const d = inspectSkillsRoot(root)
      expect(d.status).toBe('refused')
      expect(d.settingSources).toEqual([])
    },
  )

  /**
   * A refusal must never take the worker down. The agent works perfectly well
   * without skills, and a misconfigured volume that stopped chat entirely
   * would be a far worse outcome than the one it is protecting against.
   */
  it('refuses by returning, never by throwing', () => {
    expect(() => inspectSkillsRoot('/definitely/not/a/real/path')).not.toThrow()
    expect(inspectSkillsRoot('/definitely/not/a/real/path').status).toBe('refused')
  })

  it('says so when the directory has no .claude at all', () => {
    expect(inspectSkillsRoot(root).reason).toMatch(/no \.claude directory/)
  })

  it('refuses a path that is a file rather than a directory', () => {
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    expect(inspectSkillsRoot(file).status).toBe('refused')
  })
})

describe('readSkillSummary', () => {
  const skillsDir = (): string => join(root, '.claude', 'skills')

  it('reads the name and description out of the front matter', () => {
    addSkill('pipeline-review')
    expect(readSkillSummary(skillsDir(), 'pipeline-review')).toEqual({
      name: 'pipeline-review',
      description: 'A skill for pipeline-review.',
    })
  })

  it('strips quotes, which are legal YAML and not part of the value', () => {
    addSkill('quoted', 'name: "Quoted"\ndescription: \'With quotes.\'')
    expect(readSkillSummary(skillsDir(), 'quoted')).toEqual({
      name: 'Quoted',
      description: 'With quotes.',
    })
  })

  it('falls back to the directory name when there is no front matter', () => {
    const dir = join(skillsDir(), 'bare')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'Just instructions, no front matter.\n')
    expect(readSkillSummary(skillsDir(), 'bare')).toEqual({ name: 'bare', description: '' })
  })

  it('does not throw on a skill that is not there', () => {
    expect(readSkillSummary(skillsDir(), 'missing')).toEqual({ name: 'missing', description: '' })
  })
})
