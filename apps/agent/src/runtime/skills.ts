/**
 * Skills (PROMPT.md §6), and the one bypass they genuinely need.
 *
 * §6: *"Skills are filesystem-only in the SDK — they cannot be registered
 * programmatically. Mount a `skills/` volume into the agent container and set
 * `settingSources: ["project"]`, `skills: "all"`, and include `"Skill"` in
 * `allowedTools`."*
 *
 * Two of those three are refused, and the third is the problem this file
 * exists to solve.
 *
 * ## `"Skill"` in allowedTools — refused, and the SDK agrees
 *
 * A bare `allowedTools` entry auto-approves before `canUseTool` is consulted
 * (CLAUDE.md §8). It is also unnecessary: the installed SDK says of the
 * `skills` option, verbatim, *"This is the single place to turn skills on; you
 * do not need to add `'Skill'` to `allowedTools` yourself when using this
 * option."* So the recommendation costs a gate bypass and buys nothing.
 *
 * ## `settingSources: ["project"]` — genuinely required, and PROBED
 *
 * This one is not avoidable, and it was measured rather than assumed. Against
 * a scratch directory containing one `.claude/skills/pipeline-review/SKILL.md`:
 *
 *     settingSources: []          49 commands, pipeline-review present: false
 *     settingSources: ['project'] 50 commands, pipeline-review present: true
 *
 * So skills are discovered only with the project source loaded. And the SDK
 * warns that *"Allow rules from settings files can also shadow the callback
 * but are not visible here"* — the third documented way the gate is skipped.
 *
 * ## What makes it safe: the bypass is in the FILES, not in the skills
 *
 * `settingSources: ['project']` loads a set of files from `<cwd>/.claude/`.
 * Exactly one kind of them can shadow the gate — the settings files. Skills
 * themselves are markdown instructions: everything a skill makes the model
 * DO still arrives at `canUseTool` as an ordinary tool call.
 *
 * So the skills root is a directory this worker owns, and `inspectSkillsRoot`
 * refuses to enable skills if that directory contains anything that could
 * carry a permission rule. It is checked at boot, and the refusal names the
 * file. The tier that would otherwise have to be trusted —
 * `allowManagedPermissionRulesOnly` — is still set, but it is not what this
 * rests on, because it is the one layer that cannot be verified from inside
 * this repo (it is skipped on a machine that already has an IT-managed
 * settings tier).
 *
 * Off unless `AGENT_SKILLS_DIR` is set. A deployment that does not use skills
 * does not carry the setting source at all.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Files under `<root>/.claude/` that `settingSources: ['project']` reads and
 * that can carry a permission rule, an agent definition, or a hook.
 *
 * `.mcp.json` is on the list even though `strictMcpConfig: true` already
 * ignores it: a server declared there is a server nobody registered in the
 * connectors table, and defence that depends on one flag is worth having twice.
 */
const FORBIDDEN_ENTRIES = [
  'settings.json',
  'settings.local.json',
  'agents',
  'commands',
  'hooks',
  'plugins',
  'mcp.json',
] as const

export interface SkillsDecision {
  /** Pass to `settingSources`. Empty unless skills are both wanted and safe. */
  readonly settingSources: readonly 'project'[]
  /** Pass to `skills`. Undefined when off. */
  readonly skills?: 'all'
  /** For the boot log, and for `/readyz` when it refused. */
  readonly status: 'off' | 'on' | 'refused'
  readonly reason: string
  readonly names: readonly string[]
}

const OFF: SkillsDecision = {
  settingSources: [],
  status: 'off',
  reason: 'AGENT_SKILLS_DIR is not set, so no skills are loaded.',
  names: [],
}

/**
 * Decide whether skills may be turned on, from what is actually on disk.
 *
 * Pure apart from the reads, and returns a decision rather than throwing: a
 * skills directory that is unsafe must not stop the worker booting. The agent
 * keeps working without skills, and the refusal is loud.
 */
export function inspectSkillsRoot(dir: string | undefined): SkillsDecision {
  if (!dir) return OFF

  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return {
      settingSources: [],
      status: 'refused',
      reason: `AGENT_SKILLS_DIR points at ${root}, which is not a directory.`,
      names: [],
    }
  }

  const claude = join(root, '.claude')
  if (!existsSync(claude)) {
    return {
      settingSources: [],
      status: 'refused',
      reason:
        `AGENT_SKILLS_DIR (${root}) has no .claude directory. A skill lives at ` +
        '.claude/skills/<name>/SKILL.md.',
      names: [],
    }
  }

  // The whole safety argument, in one loop. If any of these is present the
  // directory is not a skills volume, it is a settings tree — and loading it
  // would put a permission rule where the SDK says one can shadow the gate
  // invisibly.
  for (const entry of FORBIDDEN_ENTRIES) {
    if (existsSync(join(claude, entry))) {
      return {
        settingSources: [],
        status: 'refused',
        reason:
          `Refusing to load skills: ${join('.claude', entry)} exists in AGENT_SKILLS_DIR. ` +
          'Loading skills means loading the project settings source, and a settings file there ' +
          'can allow tool calls without the approval gate ever being consulted. Remove it, or ' +
          'point AGENT_SKILLS_DIR at a directory that holds only .claude/skills/.',
        names: [],
      }
    }
  }

  const skillsDir = join(claude, 'skills')
  if (!existsSync(skillsDir)) {
    return {
      settingSources: [],
      status: 'refused',
      reason: `AGENT_SKILLS_DIR (${root}) has no .claude/skills directory.`,
      names: [],
    }
  }

  const names = listSkills(skillsDir)
  if (names.length === 0) {
    // Nothing to load, so nothing is worth the setting source.
    return {
      settingSources: [],
      status: 'off',
      reason: 'The skills directory is empty, so the project setting source is not loaded.',
      names: [],
    }
  }

  return {
    settingSources: ['project'],
    skills: 'all',
    status: 'on',
    reason: `${names.length} skill${names.length === 1 ? '' : 's'} loaded from ${root}.`,
    names,
  }
}

/** Every directory holding a SKILL.md. Names only — the contents are the model's. */
function listSkills(skillsDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => {
      try {
        return (
          statSync(join(skillsDir, name)).isDirectory() &&
          existsSync(join(skillsDir, name, 'SKILL.md'))
        )
      } catch {
        return false
      }
    })
    .sort()
}

/**
 * A skill's own name and description, for the settings screen.
 *
 * Read from the YAML front matter with a deliberately small parser rather than
 * a YAML library: the only two fields that matter are strings on their own
 * line, and a full parser here would be a second place that has to understand
 * a file the model also reads.
 */
export function readSkillSummary(
  skillsDir: string,
  name: string,
): { name: string; description: string } {
  let head = ''
  try {
    head = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').slice(0, 4000)
  } catch {
    return { name, description: '' }
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? ''
  const field = (key: string): string =>
    new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return { name: field('name') || name, description: field('description').slice(0, 300) }
}
