import {
  KEYLESS_AT_INITIALIZE, type ConnectorPreset, type PresetClass,
} from '@agency/core'
import { isReachableConnectorUrl, parseConnectorConfig } from '@agency/db/queries'

/**
 * The connector catalog, reduced to what a browser may see (§6, §2.3).
 *
 * The catalog in `@agency/core` is plain data and carries no credential — its
 * own test says so — but it is still the page's job to decide what crosses,
 * the same way `toView` decides for a connector row. A preset crosses as the
 * fields the card renders, plus the `config` Install posts, and nothing else:
 * no `auth` object, no `source`, and never a URL with a query string, which is
 * where a vendor's documented `?apiKey=` form would put a credential.
 *
 * Whether a preset gets an Install button is decided HERE, from rules rather
 * than from a list, so each "no" carries a sentence a person can act on:
 *
 *  - OAuth-only servers need a connect flow this product does not have.
 *  - A config the schema refuses, or a URL inside the worker's network, would
 *    be refused by the route anyway; better to say so on the card.
 *  - A stdio preset runs a package on the worker host. One click is offered
 *    only when that package is pinned to an exact version: `npx -y pkg@latest`
 *    runs whatever was published last, every time the worker starts it, and
 *    an agency that reviews other people's supply chains should not install
 *    one unreviewed by pressing a button. The catalog pins nothing today, so
 *    those presets fill in the manual form instead, where the owner names the
 *    version they reviewed. Pinning one in the catalog turns its button on
 *    with no change here.
 *
 * No `server-only` and no `@/` import: `apps/web/test/connector-catalog.test.ts`
 * imports this module directly.
 */

/** The four headings the catalog renders, in order. */
export type CatalogGroup = 'works-today' | 'named-header' | 'worker-host' | 'connect-flow'

export const CATALOG_GROUPS: readonly CatalogGroup[] = Object.freeze([
  'works-today', 'named-header', 'worker-host', 'connect-flow',
])

export interface BrowserPreset {
  readonly id: string
  readonly title: string
  readonly category: ConnectorPreset['category']
  /** The server name Install proposes. The owner may change it. */
  readonly name: string
  readonly kind: 'http' | 'sse' | 'stdio'
  readonly class: PresetClass
  readonly group: CatalogGroup
  /**
   * What Install posts as `config` — the schema's own output, so exactly the
   * keys a row keeps — or what the manual form is filled in with for a stdio
   * preset that is not one click. Null when the browser needs neither.
   */
  readonly config: Record<string, unknown> | null
  readonly installable: boolean
  /** Why there is no Install button, as a sentence. Null when there is one. */
  readonly notInstallable: string | null
  /** A green Test connection proves the endpoint answers and nothing about the key. */
  readonly keyless: boolean
  readonly needsCredential: boolean
  /** What the credential field is called. Null when the server takes none this product can store. */
  readonly credentialLabel: string | null
  readonly docsUrl: string | null
  readonly notes: readonly string[]
  readonly sendTools: readonly string[]
}

const GROUP_OF: Readonly<Record<PresetClass, CatalogGroup>> = {
  bearer: 'works-today',
  none: 'works-today',
  'named-header': 'named-header',
  'stdio-env': 'worker-host',
  'oauth-only': 'connect-flow',
}

/** Every preset, reduced, grouped in heading order and in catalog order within a group. */
export function browserPresets(catalog: readonly ConnectorPreset[]): BrowserPreset[] {
  const reduced = catalog.map(reduce)
  return CATALOG_GROUPS.flatMap((group) => reduced.filter((p) => p.group === group))
}

function reduce(preset: ConnectorPreset): BrowserPreset {
  const takesCredential = preset.auth.cls !== 'none' && preset.auth.cls !== 'oauth-only'
  const base = {
    id: preset.id,
    title: preset.title,
    category: preset.category,
    name: preset.name,
    kind: preset.kind,
    class: preset.auth.cls,
    group: GROUP_OF[preset.auth.cls],
    keyless: KEYLESS_AT_INITIALIZE.includes(preset.id),
    needsCredential: preset.auth.needsCredential,
    credentialLabel: takesCredential ? preset.auth.credentialLabel : null,
    docsUrl: carriesNothingInItsUrl(preset.docsUrl) ? preset.docsUrl : null,
    notes: [...preset.notes],
    sendTools: [...preset.sendTools],
  }
  const refuse = (why: string, config: Record<string, unknown> | null = null): BrowserPreset => ({
    ...base,
    config,
    installable: false,
    notInstallable: why,
  })

  if (!preset.installable) {
    return refuse('Needs a connect flow (OAuth) that this product does not have. Not built.')
  }
  const parsed = parseConnectorConfig(preset.kind, preset.config)
  if (!parsed.ok) return refuse(`Its settings do not validate (${parsed.message}), so it is not offered.`)
  const config = parsed.value as Record<string, unknown>

  if (preset.kind === 'stdio') {
    const { command, args } = parsed.value as { command: string; args: string[] }
    const unpinned = unpinnedPackage(command, args)
    if (unpinned) {
      return refuse(
        `Runs ${unpinned}, which is not pinned to a version. Review the package, then add it with ` +
          'the form at the exact version you reviewed.',
        config,
      )
    }
    return { ...base, config, installable: true, notInstallable: null }
  }

  const { url } = parsed.value as { url: string }
  if (!carriesNothingInItsUrl(url)) {
    return refuse('Its URL carries a query string, which is where a credential ends up. Not offered.')
  }
  if (!isReachableConnectorUrl(url)) {
    return refuse('Its URL points inside the network the worker runs in. Not offered.')
  }
  return { ...base, config, installable: true, notInstallable: null }
}

/** A URL with no query string and no fragment: the two places a credential rides. */
function carriesNothingInItsUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** `pkg@1.2.3` or `@scope/pkg@1.2.3`, optionally with a pre-release. Not a range, not a tag. */
const EXACT_NPM = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i
/** `pkg==1.2.3` or `pkg@1.2.3`, extras allowed. */
const EXACT_PYPI = /^[a-z0-9][a-z0-9._-]*(\[[a-z0-9,._-]+\])?(==|@)\d+(\.\d+)*([a-z]+\d*)?$/i

/**
 * The package spec a stdio command runs, when it runs one that is not pinned
 * to an exact version — or null when it is pinned, or when the command is not
 * a package runner at all (a binary on the worker image is whatever the image
 * installed, and pinning it is the image's business).
 */
export function unpinnedPackage(command: string, args: readonly string[]): string | null {
  const runner = command.split('/').pop() ?? command
  const npm = runner === 'npx' || runner === 'bunx'
  const pypi = runner === 'uvx'
  if (!npm && !pypi) return null
  const spec = optionValue(args, npm ? ['-p', '--package'] : ['--from']) ?? args.find((a) => !a.startsWith('-'))
  if (!spec) return command
  return (npm ? EXACT_NPM : EXACT_PYPI).test(spec) ? null : spec
}

/** The value given to one of these options, as `--opt value` or `--opt=value`. */
function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (names.includes(arg)) return args[i + 1]
    const eq = names.find((n) => n.startsWith('--') && arg.startsWith(`${n}=`))
    if (eq) return arg.slice(eq.length + 1)
  }
  return undefined
}
