/**
 * The two halves of "a workspace reaches a container" (CLAUDE.md §4).
 *
 * This is the mistake this repo has already made twice, and it is silent
 * both ways: `npm ci` exits 0 when a workspace package.json was not copied
 * (it creates no `node_modules/@agency/<name>` symlink at all) and exits 0
 * when the workspace is copied but never declared (the symlink dangles).
 * Nothing is red in the build; the container dies later with
 * ERR_MODULE_NOT_FOUND, in a deployment, on a phone call.
 *
 * `packages/scanner` was missing from two images that way. `packages/llm`
 * was missing from three the moment it was created. So the rule is a test
 * rather than a comment in the Dockerfiles that says it: this file reads
 * the workspaces off the filesystem, so a package added next year is
 * checked without anybody remembering to add it here.
 *
 * It does NOT build an image — there is no Docker on the dev machine, and
 * the original finding was reproduced by replicating a stage's COPY set on
 * disk by hand. What it checks is the thing that was wrong both times.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Every workspace, read off disk rather than listed here. */
function workspaces(): string[] {
  const found: string[] = []
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, group))) {
      if (existsSync(join(ROOT, group, name, 'package.json'))) found.push(`${group}/${name}`)
    }
  }
  return found.sort()
}

function packageJson(dir: string): { name: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
    name: string
    dependencies?: Record<string, string>
  }
}

/** A Dockerfile's stages, split on FROM, keyed by their `AS <name>`. */
function stages(dockerfile: string): Map<string, string> {
  const out = new Map<string, string>()
  let current = 'unnamed'
  let body: string[] = []
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line)
    if (from) {
      if (body.length) out.set(current, body.join('\n'))
      current = from[1] ?? 'unnamed'
      body = []
    }
    body.push(line)
  }
  if (body.length) out.set(current, body.join('\n'))
  return out
}

/** `@agency/*` dependencies of a workspace, transitively. */
function agencyDepsOf(dir: string, byName: Map<string, string>): Set<string> {
  const seen = new Set<string>()
  const walk = (d: string): void => {
    for (const dep of Object.keys(packageJson(d).dependencies ?? {})) {
      if (!dep.startsWith('@agency/')) continue
      const depDir = byName.get(dep)
      if (!depDir || seen.has(depDir)) continue
      seen.add(depDir)
      walk(depDir)
    }
  }
  walk(dir)
  return seen
}

const IMAGES = readdirSync(join(ROOT, 'apps'))
  .map((name) => `apps/${name}/Dockerfile`)
  .filter((path) => existsSync(join(ROOT, path)))

describe('the container images', () => {
  const all = workspaces()
  const byName = new Map(all.map((dir) => [packageJson(dir).name, dir]))

  it('finds the Dockerfiles it is meant to be checking', () => {
    // Guards against this whole suite passing vacuously if apps/ is renamed.
    expect(IMAGES.length).toBeGreaterThanOrEqual(3)
    expect(all).toContain('packages/llm')
  })

  describe.each(IMAGES)('%s', (image) => {
    const text = readFileSync(join(ROOT, image), 'utf8')
    const byStage = [...stages(text).entries()]
    const installing = byStage.filter(([, body]) => /^RUN npm ci\b/m.test(body))

    it('runs npm ci somewhere', () => {
      expect(installing.length).toBeGreaterThan(0)
    })

    /**
     * Half one. `npm ci --include-workspace-root` resolves the whole
     * lockfile, so every workspace package.json has to be present even for
     * the ones this image never runs — which is why these images copy
     * files they do not otherwise use.
     */
    it.each(installing.map(([name]) => name))('copies every workspace package.json in %s', (stage) => {
      const body = stages(text).get(stage)!
      const missing = all.filter((dir) => !body.includes(`COPY ${dir}/package.json`))
      expect(missing).toEqual([])
    })

    /**
     * Half two, for the images that run compiled JavaScript: a declared and
     * installed workspace whose dist/ never reached the runner is the same
     * ERR_MODULE_NOT_FOUND from the other direction. Next's standalone
     * output traces its own files, so an image built that way is exempt.
     */
    it('copies the dist/ of everything the entrypoint imports', () => {
      const runner = byStage.at(-1)![1]
      const entry = /CMD \["node", "(apps\/[^/]+)\/dist\/index\.js"\]/.exec(runner)
      if (!entry) {
        expect(runner).toMatch(/\.next\/standalone/)
        return
      }
      const app = entry[1]!
      const needed = [...agencyDepsOf(app, byName), app].sort()
      const missing = needed.filter((dir) => !new RegExp(`COPY --from=\\S+ [^\\n]*${dir}/dist`).test(runner))
      expect(missing).toEqual([])
    })
  })
})
