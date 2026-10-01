/**
 * The connector catalog is DATA, and every claim in it was checked against
 * `fixtures/mcp-catalog-verified.md` — a vendored copy of the research that
 * probed each endpoint. These tests hold the data to that file and to §2.3:
 * a preset carries a place for a credential, never one.
 *
 * `apps/web/test/connector-catalog.test.ts` (wave 2) additionally runs every
 * installable config through `parseConnectorConfig`, which lives in
 * packages/db and cannot be imported from here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CONNECTOR_CATALOG, KEYLESS_AT_INITIALIZE, presetById, SENSITIVE_VALUE, type ConnectorPreset,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const CATALOG_MD = readFileSync(join(here, 'fixtures', 'mcp-catalog-verified.md'), 'utf8')

/**
 * A literal copy of `FORBIDDEN_SECRET_ENV` from packages/db/src/connectors.ts,
 * because core cannot import db. If the two drift, the wave-2 web test that
 * parses every preset through the real schema is the one that catches it.
 */
const FORBIDDEN_SECRET_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'NODE_OPTIONS', 'PATH', 'HOME', 'USER',
  'LOGNAME', 'SHELL', 'TMPDIR', 'LD_PRELOAD', 'NODE_EXTRA_CA_CERTS', 'DATABASE_URL', 'SECRETS_KEY', 'CLAUDE_CONFIG_DIR',
]

/** Well-known credential prefixes; a preset must not ship one as a "default". */
const CREDENTIAL_SHAPED = /^(sk|pk|rk|ghp|gho|github_pat|xox[abp]|hf|tvly|fc|whsec|re|sntrys|glpat|cal_live)[-_]/i

const installable = CONNECTOR_CATALOG.filter((p) => p.installable)
const notBuilt = CONNECTOR_CATALOG.filter((p) => !p.installable)

function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => stringValues(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringValues(v, out))
  return out
}

describe('the connector catalog', () => {
  it('holds the twenty-seven installable presets and the seven that need a connect flow', () => {
    expect(installable).toHaveLength(27)
    expect(notBuilt).toHaveLength(7)
  })

  it('has no duplicate ids', () => {
    const ids = CONNECTOR_CATALOG.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * The in-process server is spread LAST at runtime, so a connector named
   * `agency` would silently displace it and its tools would classify as
   * agency tools. `connectors_name_is_not_agency` refuses it at the database;
   * the catalog must never suggest it.
   */
  it('never names a server agency, and every name is a valid server name', () => {
    for (const p of CONNECTOR_CATALOG) {
      expect(p.name, p.id).not.toBe('agency')
      expect(p.name, p.id).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
    }
  })

  it('reaches every http server over https', () => {
    for (const p of CONNECTOR_CATALOG) {
      if (p.kind === 'stdio') continue
      const url = p.config['url']
      expect(typeof url, p.id).toBe('string')
      expect(url as string, p.id).toMatch(/^https:\/\//)
    }
  })

  it('gives every named-header preset a secretHeader, and every stdio preset a permitted secretEnv', () => {
    for (const p of CONNECTOR_CATALOG) {
      if (p.auth.cls === 'named-header') {
        expect(typeof p.config['secretHeader'], p.id).toBe('string')
        expect(p.config['secretHeader'] as string, p.id).toMatch(/^[a-z][a-z0-9-]*$/)
      }
      if (p.kind === 'stdio') {
        expect(p.auth.cls, p.id).toBe('stdio-env')
        const env = p.config['secretEnv']
        expect(typeof env, p.id).toBe('string')
        expect(env as string, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
        expect(FORBIDDEN_SECRET_ENV, p.id).not.toContain(env)
        expect((env as string).startsWith('CLAUDE_'), p.id).toBe(false)
      }
    }
  })

  it('marks every OAuth-only preset as not installable, and nothing else', () => {
    for (const p of CONNECTOR_CATALOG) {
      expect(p.installable, p.id).toBe(p.auth.cls !== 'oauth-only')
      if (!p.installable) expect(p.auth.needsCredential, p.id).toBe(false)
    }
  })

  /**
   * §2.3. A preset is a template a person installs as-is, so a credential —
   * or a placeholder for one in a URL — would be stored in plain jsonb by
   * everybody who clicked Install.
   */
  it('carries no credential-shaped value and no credential slot in a URL', () => {
    for (const p of CONNECTOR_CATALOG) {
      for (const s of stringValues(p.config)) {
        expect(SENSITIVE_VALUE.test(s), `${p.id}: ${s}`).toBe(false)
        expect(CREDENTIAL_SHAPED.test(s), `${p.id}: ${s}`).toBe(false)
      }
      const url = p.config['url']
      if (typeof url === 'string') {
        expect(url, p.id).not.toMatch(/key=|token=|\/\{/i)
      }
      // The env and headers maps hold only non-secret configuration.
      const headers = (p.config['headers'] ?? {}) as Record<string, string>
      for (const [k, v] of Object.entries(headers)) {
        expect(k.toLowerCase(), `${p.id} header ${k}`).not.toMatch(/authorization|api[-_]?key|api[-_]?token|secret/)
        expect(v, `${p.id} header ${k}`).not.toMatch(/bearer\s/i)
      }
      expect(p.config['env'] ?? {}, p.id).toEqual({})
    }
  })

  /**
   * Every entry was read from the research file, and says which row. A
   * preset whose `source` resolves to nothing is a claim about somebody
   * else's server that nobody here checked.
   */
  it('names a **Name** cell in the vendored catalog as the source of every preset', () => {
    const cells = new Set(
      [...CATALOG_MD.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((m) => m[1]!.trim()),
    )
    expect(cells.size).toBeGreaterThan(25)
    for (const p of CONNECTOR_CATALOG) {
      expect(cells.has(p.source), `${p.id}: source "${p.source}" is not a row in mcp-catalog-verified.md`).toBe(true)
    }
  })

  it('lists exactly the presets whose server accepts a wrong key at initialize', () => {
    const flagged = CONNECTOR_CATALOG.filter((p) => p.keylessAtInitialize).map((p) => p.id)
    expect([...KEYLESS_AT_INITIALIZE].sort()).toEqual(flagged.sort())
    // The research's own list: initialize succeeds with a garbage token on these.
    for (const id of ['exa', 'firecrawl', 'jina', 'context7', 'intercom', 'pipedrive', 'sentry']) {
      expect(KEYLESS_AT_INITIALIZE, id).toContain(id)
    }
    // And a server that refuses a bad token at initialize is not on it.
    expect(KEYLESS_AT_INITIALIZE).not.toContain('tavily')
    expect(KEYLESS_AT_INITIALIZE).not.toContain('linear')
  })

  it('puts every tool that sends on the disable list for the servers that only send', () => {
    expect(presetById('zapier')!.sendTools).toEqual(['*'])
    expect(presetById('apollo')!.sendTools).toEqual(['*'])
    expect(presetById('stripe')!.sendTools).toContain('create_refund')
    // A read-only server has nothing to disable.
    expect(presetById('github')!.sendTools).toEqual([])
  })

  it('gives every preset a docs link over https, a title and at least one verified note', () => {
    for (const p of CONNECTOR_CATALOG) {
      expect(p.docsUrl, p.id).toMatch(/^https:\/\//)
      expect(p.title.length, p.id).toBeGreaterThan(1)
      expect(p.notes.length, p.id).toBeGreaterThan(0)
    }
  })

  it('finds a preset by id and answers null for a stranger', () => {
    const exa: ConnectorPreset | null = presetById('exa')
    expect(exa?.kind).toBe('http')
    expect(presetById('resend')).toBeNull()
    expect(presetById('instantly')).toBeNull()
  })

  it('is frozen', () => {
    expect(Object.isFrozen(CONNECTOR_CATALOG)).toBe(true)
    expect(Object.isFrozen(KEYLESS_AT_INITIALIZE)).toBe(true)
  })
})
