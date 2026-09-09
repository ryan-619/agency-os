import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PROMPT.md §3: "packages/core must have no dependency on Next.js, the Agent
 * SDK, or any HTTP framework. Domain rules are testable in isolation. This is
 * the one architectural rule worth being pedantic about."
 *
 * This test is the pedantry. It reads the source rather than trusting review.
 */

const SRC = new URL('../src/', import.meta.url).pathname
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** Modules that would make a domain rule untestable in isolation. */
const FORBIDDEN_IMPORTS = [
  'next',
  'next/',
  'react',
  'express',
  'fastify',
  'koa',
  '@anthropic-ai/claude-agent-sdk',
  'drizzle-orm',
  'pg',
  '@electric-sql/pglite',
  'nodemailer',
  'pg-boss',
]

/** Node built-ins are I/O by definition; core is pure. */
const FORBIDDEN_BUILTINS = [
  'node:fs',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  'node:dns',
  'fs',
  'http',
  'https',
  'net',
  'child_process',
]

describe('packages/core stays pure', () => {
  const files = sourceFiles(SRC)

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('declares no runtime dependencies at all', () => {
    expect(PKG.dependencies ?? {}).toEqual({})
  })

  it('imports no framework, database driver, or agent SDK', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of specifiers) {
        for (const banned of FORBIDDEN_IMPORTS) {
          const hit = spec === banned || (banned.endsWith('/') && spec.startsWith(banned))
          expect(hit, `${file} imports "${spec}", which is banned in packages/core`).toBe(false)
        }
      }
    }
  })

  it('imports no Node I/O built-in', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of specifiers) {
        expect(
          FORBIDDEN_BUILTINS.includes(spec),
          `${file} imports "${spec}"; packages/core must do no I/O`,
        ).toBe(false)
      }
    }
  })

  it('does not reach for process.env — configuration is the caller’s job', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src.includes('process.env'), `${file} reads process.env`).toBe(false)
    }
  })
})
