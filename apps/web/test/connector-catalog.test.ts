/**
 * The connector catalog, as the install flow will use it (§6, §2.3).
 *
 * `packages/core/test/connector-catalog.test.ts` checks the catalog as DATA:
 * no duplicate ids, a verified source for every entry, nothing
 * credential-shaped. What it cannot check is whether each preset survives the
 * two things between the button and a working connector — the route's schema
 * and the worker's placement — because `packages/core` may not import either.
 * This file can, so this is where "Install" is proved to produce a row the
 * route accepts and the worker sends the credential where the server reads it.
 *
 * It also pins the boundary: what a preset looks like once it has crossed to
 * the browser.
 */
import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG, KEYLESS_AT_INITIALIZE, type ConnectorPreset } from '@agency/core'
import {
  isReachableConnectorUrl, parseConnectorConfig, secretEnvName, secretPlacement,
  type HttpConfig, type StdioConfig,
} from '@agency/db/queries'
import { browserPresets, CATALOG_GROUPS, unpinnedPackage } from '../src/components/settings/connector-presets'

const installable = CONNECTOR_CATALOG.filter((p) => p.installable)

describe('every installable preset, through the route’s own checks', () => {
  it.each(installable.map((p) => [p.id, p] as const))('%s passes parseConnectorConfig', (_id, preset) => {
    const parsed = parseConnectorConfig(preset.kind, preset.config)
    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true)
  })

  it.each(installable.filter((p) => p.kind !== 'stdio').map((p) => [p.id, p] as const))(
    '%s points outside the worker’s network',
    (_id, preset) => {
      expect(isReachableConnectorUrl((preset.config as { url: string }).url)).toBe(true)
    },
  )
})

describe('where the worker will put the credential', () => {
  const parsedHttp = (p: ConnectorPreset): HttpConfig => {
    const parsed = parseConnectorConfig(p.kind, p.config)
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.value as HttpConfig
  }

  /**
   * The reason class B exists. A named-header preset that resolved to
   * `authorization: Bearer` would install cleanly and then send the key
   * somewhere the server never reads it — and for the servers that accept
   * anything at initialize, Test connection would still go green.
   */
  it.each(CONNECTOR_CATALOG.filter((p) => p.auth.cls === 'named-header').map((p) => [p.id, p] as const))(
    '%s resolves to its own header, or to the Sentry scheme',
    (_id, preset) => {
      const { header, prefix } = secretPlacement(parsedHttp(preset))
      expect(header !== 'authorization' || prefix === 'Sentry-Bearer ').toBe(true)
    },
  )

  it('sends x-api-key with no scheme for Hunter, and Sentry-Bearer for Sentry', () => {
    const byId = (id: string) => CONNECTOR_CATALOG.find((p) => p.id === id)!
    expect(secretPlacement(parsedHttp(byId('hunter')))).toEqual({ header: 'x-api-key', prefix: '' })
    expect(secretPlacement(parsedHttp(byId('sentry')))).toEqual({ header: 'authorization', prefix: 'Sentry-Bearer ' })
  })

  it('leaves every Bearer preset on authorization: Bearer', () => {
    for (const preset of installable.filter((p) => p.auth.cls === 'bearer')) {
      expect(secretPlacement(parsedHttp(preset)), preset.id).toEqual({ header: 'authorization', prefix: 'Bearer ' })
    }
  })

  it('names a variable other than MCP_SECRET for every stdio preset', () => {
    for (const preset of installable.filter((p) => p.kind === 'stdio')) {
      const parsed = parseConnectorConfig('stdio', preset.config)
      if (!parsed.ok) throw new Error(parsed.message)
      expect(secretEnvName(parsed.value as StdioConfig), preset.id).not.toBe('MCP_SECRET')
    }
  })
})

describe('what crosses to the browser', () => {
  const presets = browserPresets(CONNECTOR_CATALOG)

  it('is every preset, once, grouped in heading order', () => {
    expect(presets.map((p) => p.id).sort()).toEqual(CONNECTOR_CATALOG.map((p) => p.id).sort())
    const groupIndexes = presets.map((p) => CATALOG_GROUPS.indexOf(p.group))
    expect(groupIndexes).toEqual([...groupIndexes].sort((a, b) => a - b))
  })

  /** The boundary, key by key: a field added to the preset does not cross by accident. */
  it('carries exactly the fields the card renders and Install posts', () => {
    for (const p of presets) {
      expect(Object.keys(p).sort()).toEqual(
        [
          'category', 'class', 'config', 'credentialLabel', 'docsUrl', 'group', 'id', 'installable',
          'keyless', 'kind', 'name', 'needsCredential', 'notInstallable', 'notes', 'sendTools', 'title',
        ].sort(),
      )
    }
  })

  it('never carries a URL with a query string, a fragment or userinfo', () => {
    const urls = JSON.stringify(presets).match(/https?:\/\/[^"\s]+/g) ?? []
    expect(urls.length).toBeGreaterThan(20)
    for (const raw of urls) {
      const url = new URL(raw)
      expect(url.search + url.hash + url.username + url.password, raw).toBe('')
    }
  })

  it('posts the schema’s own output, so the route receives exactly what it will store', () => {
    for (const p of presets.filter((b) => b.installable)) {
      const parsed = parseConnectorConfig(p.kind, p.config)
      expect(parsed.ok && parsed.value, p.id).toEqual(p.config)
    }
  })

  it('offers no Install button for an OAuth-only server, and sends it no config', () => {
    const oauth = presets.filter((p) => p.class === 'oauth-only')
    expect(oauth).toHaveLength(7)
    for (const p of oauth) {
      expect(p).toMatchObject({ group: 'connect-flow', installable: false, config: null, credentialLabel: null })
      expect(p.notInstallable).toMatch(/connect flow/)
    }
  })

  it('offers every hosted preset as one click', () => {
    const hosted = presets.filter((p) => p.kind !== 'stdio' && p.class !== 'oauth-only')
    expect(hosted.length).toBe(23)
    for (const p of hosted) expect(p.installable, p.id).toBe(true)
  })

  /**
   * The catalog pins no stdio package today (`@latest`, or no version at all),
   * so none is one click: each fills in the form instead, where the owner
   * names the version they reviewed. The config still crosses, for that.
   */
  it('does not offer an unpinned stdio package as one click, and names it', () => {
    const stdio = presets.filter((p) => p.kind === 'stdio')
    expect(stdio.map((p) => p.id).sort()).toEqual(['brave', 'semgrep', 'sentry-stdio', 'snyk'])
    for (const p of stdio) {
      expect(p.group).toBe('worker-host')
      expect(p.installable, p.id).toBe(false)
      expect(p.config).not.toBeNull()
    }
    expect(stdio.find((p) => p.id === 'snyk')!.notInstallable).toMatch(/^Runs snyk@latest, which is not pinned/)
    expect(stdio.find((p) => p.id === 'semgrep')!.notInstallable).toMatch(/^Runs semgrep-mcp,/)
  })

  it('offers a stdio preset once its package is pinned — with no change to the page', () => {
    const snyk = CONNECTOR_CATALOG.find((p) => p.id === 'snyk')!
    const pinned: ConnectorPreset = {
      ...snyk,
      config: { ...snyk.config, args: ['-y', 'snyk@1.1300.2', 'mcp', '-t', 'stdio'] },
    }
    expect(browserPresets([pinned])[0]).toMatchObject({ installable: true, notInstallable: null })
  })

  it('refuses a preset whose URL would carry a credential, rather than trimming it', () => {
    const exa = CONNECTOR_CATALOG.find((p) => p.id === 'exa')!
    const leaky: ConnectorPreset = {
      ...exa,
      config: { url: 'https://mcp.exa.ai/mcp?exaApiKey=canary-7f3e', headers: {} },
    }
    const [reduced] = browserPresets([leaky])
    expect(reduced).toMatchObject({ installable: false, config: null })
    expect(reduced!.notInstallable).toMatch(/query string/)
    expect(JSON.stringify(reduced)).not.toContain('canary-7f3e')
  })

  it('refuses a preset pointing inside the worker’s network', () => {
    const exa = CONNECTOR_CATALOG.find((p) => p.id === 'exa')!
    const inside: ConnectorPreset = { ...exa, config: { url: 'http://169.254.169.254/mcp', headers: {} } }
    expect(browserPresets([inside])[0]).toMatchObject({ installable: false, config: null })
  })

  it('marks exactly the presets whose server accepts a wrong key at initialize', () => {
    expect(presets.filter((p) => p.keyless).map((p) => p.id).sort()).toEqual([...KEYLESS_AT_INITIALIZE].sort())
  })

  it('asks for a credential only where one can be stored and used', () => {
    for (const p of presets) {
      if (p.class === 'none' || p.class === 'oauth-only') expect(p.credentialLabel, p.id).toBeNull()
      else expect(p.credentialLabel, p.id).toBeTruthy()
    }
  })
})

describe('unpinnedPackage', () => {
  it.each([
    ['npx', ['-y', 'snyk@latest', 'mcp'], 'snyk@latest'],
    ['npx', ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'], '@brave/brave-search-mcp-server'],
    ['npx', ['-y', '@sentry/mcp-server@^0.20.0'], '@sentry/mcp-server@^0.20.0'],
    ['npx', ['-y', '@sentry/mcp-server@0.20.0'], null],
    ['npx', ['-y', 'pkg@1.2.3-beta.1'], null],
    ['npx', ['--package', 'tool@2.0.0', 'tool-bin'], null],
    ['npx', ['--package=tool@next', 'tool-bin'], 'tool@next'],
    ['/usr/local/bin/npx', ['-y', 'x'], 'x'],
    ['uvx', ['semgrep-mcp'], 'semgrep-mcp'],
    ['uvx', ['semgrep-mcp==0.9.0'], null],
    ['uvx', ['--from', 'semgrep-mcp@0.9.0', 'semgrep-mcp'], null],
    ['npx', [], 'npx'],
    ['/opt/tools/bin/my-server', ['--stdio'], null],
  ] as const)('%s %j → %s', (command, args, expected) => {
    expect(unpinnedPackage(command, args)).toBe(expected)
  })
})
