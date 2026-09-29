/**
 * The connector catalog: MCP servers the agency can install from a list
 * rather than a blank form (§6).
 *
 * Every entry was READ from `test/fixtures/mcp-catalog-verified.md`, a
 * vendored copy of the research that probed each endpoint and unpacked each
 * package; `source` names the row it came from, and `test/connector-catalog.test.ts`
 * resolves every one. An entry with no row in that file does not exist here —
 * a preset is a claim about somebody else's server, and the only claims this
 * list makes are the ones that were checked.
 *
 * Plain data, no I/O, no imports: `packages/core/test/no-io.test.ts` reads
 * the source. The stored shape is the connector's own `config` (url /
 * headers / secretHeader / secretPrefix, or command / args / env /
 * secretEnv), so the install flow posts it as-is to the existing route.
 *
 * What a preset never carries is a credential, or a place for one (§2.3):
 * `config` names WHERE the worker puts the secret and never what it is, and
 * the test asserts no config string is credential-shaped and no URL carries
 * `key=`, `token=` or a `/{…}` placeholder.
 *
 * Excluded on purpose, each with the rule it broke:
 *   - Neon's stdio package: the key is a positional argument on the command
 *     line, visible in `ps` to anyone on the host (§2.3).
 *   - Notion's and Cal.com's stdio packages: the first is "no longer actively
 *     maintained or supported" by its own README; the second opens with
 *     "active development, subject to rapid changes". A connector the agent
 *     follows on every turn cannot stand on either.
 *   - Resend and Instantly: second send paths with no read-only mode, and
 *     neither is in the verified catalog. There is ONE send path (§8.4).
 *   - Every `?apiKey=` / `?t=` URL form the vendors still document: a
 *     credential in a URL lands in request logs (§2.3).
 */

/** How a preset authenticates, which decides what the install form asks for. */
export type PresetClass = 'bearer' | 'named-header' | 'stdio-env' | 'oauth-only' | 'none'

export interface ConnectorPreset {
  readonly id: string
  readonly title: string
  readonly category: 'research' | 'crm' | 'work' | 'engineering' | 'scheduling'
  /** The default MCP server name. Never 'agency' — `connectors_name_is_not_agency`. */
  readonly name: string
  readonly kind: 'http' | 'sse' | 'stdio'
  /**
   * Already in the stored shape: url/headers/secretHeader/secretPrefix, or
   * command/args/env/secretEnv. A name for the credential's slot, never a
   * value for it.
   */
  readonly config: Record<string, unknown>
  readonly auth: {
    readonly cls: PresetClass
    readonly needsCredential: boolean
    /** What the install form calls the credential field. */
    readonly credentialLabel: string
    /** The server answers without one; the key widens what it will do. */
    readonly optional?: true
  }
  readonly docsUrl: string
  /** The `**Name**` cell in the vendored copy of mcp-catalog-verified.md this entry was read from. */
  readonly source: string
  /** False for oauth-only: listed under "needs a connect flow, not built" with no Install button. */
  readonly installable: boolean
  /**
   * "Test connection passes with a wrong key — the key is checked at call
   * time." The install copy says a green test does not prove the credential.
   */
  readonly keylessAtInitialize?: true
  /** The verified caveats, as the research recorded them. */
  readonly notes: readonly string[]
  /**
   * Bare tool names that can SEND or act on another SaaS. Pre-filled into
   * `disabledTools` when the preset is installed (connector-tool-disable).
   * Names as documented; the disable list is names, so a wrong one costs
   * nothing. `['*']` means every tool the server has.
   */
  readonly sendTools: readonly string[]
}

/** The measured caveat every stdio preset carries (connectors-and-agents-settings §7.3). */
const STDIO_CAVEAT =
  'A stdio server is a process on the worker host: the CLI’s own environment reaches the child, ' +
  'and the whole mcpServers JSON rides on the claude argv.'

const bearer = (label = 'API key'): ConnectorPreset['auth'] => ({
  cls: 'bearer',
  needsCredential: true,
  credentialLabel: label,
})

const optionalBearer = (label = 'API key'): ConnectorPreset['auth'] => ({
  cls: 'bearer',
  needsCredential: false,
  credentialLabel: label,
  optional: true,
})

const oauthOnly: ConnectorPreset['auth'] = {
  cls: 'oauth-only',
  needsCredential: false,
  credentialLabel: 'OAuth (a connect flow this product does not have)',
}

export const CONNECTOR_CATALOG: readonly ConnectorPreset[] = Object.freeze([
  // -------------------------------------------------------------------------
  // Class A — Bearer or none: the worker's injected header works as-is.
  // -------------------------------------------------------------------------
  {
    id: 'exa',
    title: 'Exa',
    category: 'research',
    name: 'exa',
    kind: 'http',
    config: { url: 'https://mcp.exa.ai/mcp', headers: {} },
    auth: optionalBearer('Exa API key'),
    docsUrl: 'https://exa.ai/docs/get-started/exa-mcp',
    source: 'Exa',
    installable: true,
    keylessAtInitialize: true,
    notes: [
      'Keyless: web_search_exa and web_fetch_exa answer without a key; the key is checked at call time.',
      'Never the ?exaApiKey= query form the README still documents.',
    ],
    sendTools: [],
  },
  {
    id: 'firecrawl',
    title: 'Firecrawl',
    category: 'research',
    name: 'firecrawl',
    kind: 'http',
    config: { url: 'https://mcp.firecrawl.dev/v2/mcp', headers: {} },
    auth: optionalBearer('Firecrawl API key'),
    docsUrl: 'https://docs.firecrawl.dev/mcp-server',
    source: 'Firecrawl',
    installable: true,
    keylessAtInitialize: true,
    notes: [
      'Keyless, the hosted server exposes three tools: firecrawl_scrape, firecrawl_search, firecrawl_parse.',
      'Not the scanner — it reads public pages a person names, and nothing it returns is a finding.',
      '/v2/mcp-search is OAuth-only.',
    ],
    sendTools: [],
  },
  {
    id: 'tavily',
    title: 'Tavily',
    category: 'research',
    name: 'tavily',
    kind: 'http',
    config: { url: 'https://mcp.tavily.com/mcp/', headers: {} },
    auth: bearer('Tavily API key (tvly-…)'),
    docsUrl: 'https://docs.tavily.com/documentation/mcp',
    source: 'Tavily',
    installable: true,
    notes: ['Never the ?tavilyApiKey= query form — it is the first form on the docs page.'],
    sendTools: [],
  },
  {
    id: 'jina',
    title: 'Jina AI',
    category: 'research',
    name: 'jina',
    kind: 'http',
    config: { url: 'https://mcp.jina.ai/v1', headers: {} },
    auth: optionalBearer('Jina API key'),
    docsUrl: 'https://github.com/jina-ai/MCP',
    source: 'Jina AI',
    installable: true,
    keylessAtInitialize: true,
    notes: [
      'A GET on the endpoint hangs; Test connection must POST.',
      'The key is optional and checked at call time.',
    ],
    sendTools: [],
  },
  {
    id: 'context7',
    title: 'Context7',
    category: 'research',
    name: 'context7',
    kind: 'http',
    config: { url: 'https://mcp.context7.com/mcp', headers: {} },
    auth: optionalBearer('Context7 API key'),
    docsUrl: 'https://github.com/upstash/context7',
    source: 'Context7',
    installable: true,
    keylessAtInitialize: true,
    notes: ['The key is optional; a garbage key is accepted at initialize.'],
    sendTools: [],
  },
  {
    id: 'deepwiki',
    title: 'DeepWiki',
    category: 'research',
    name: 'deepwiki',
    kind: 'http',
    config: { url: 'https://mcp.deepwiki.com/mcp', headers: {} },
    auth: { cls: 'none', needsCredential: false, credentialLabel: 'none' },
    docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    source: 'DeepWiki',
    installable: true,
    notes: [
      'No authentication. A GET hangs; Test connection must POST.',
      'Private repositories need the Devin MCP server and a Devin API key, which this preset is not.',
    ],
    sendTools: [],
  },
  {
    id: 'huggingface',
    title: 'Hugging Face',
    category: 'research',
    name: 'huggingface',
    kind: 'http',
    config: { url: 'https://huggingface.co/mcp', headers: {} },
    auth: optionalBearer('Hugging Face token (hf_…)'),
    docsUrl: 'https://github.com/huggingface/hf-mcp-server',
    source: 'Hugging Face',
    installable: true,
    notes: [
      'Token-less requests get the anonymous tool set; a malformed token is refused, not downgraded.',
    ],
    sendTools: [],
  },
  {
    id: 'linear',
    title: 'Linear (read-only)',
    category: 'work',
    name: 'linear',
    kind: 'http',
    config: { url: 'https://mcp.linear.app/mcp/readonly', headers: {} },
    auth: bearer('Linear API key'),
    docsUrl: 'https://linear.app/docs/mcp',
    source: 'Linear',
    installable: true,
    notes: ['The read-only endpoint is the default; linear-full is the same server with writes.'],
    sendTools: [],
  },
  {
    id: 'linear-full',
    title: 'Linear (read and write)',
    category: 'work',
    name: 'linear',
    kind: 'http',
    config: { url: 'https://mcp.linear.app/mcp', headers: {} },
    auth: bearer('Linear API key'),
    docsUrl: 'https://linear.app/docs/mcp',
    source: 'Linear',
    installable: true,
    notes: ['Writes issues and comments in Linear. Prefer the read-only preset unless the writes are wanted.'],
    sendTools: [],
  },
  {
    id: 'intercom',
    title: 'Intercom',
    category: 'crm',
    name: 'intercom',
    kind: 'http',
    config: { url: 'https://mcp.intercom.com/mcp', headers: {} },
    auth: bearer('Intercom access token'),
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    source: 'Intercom',
    installable: true,
    keylessAtInitialize: true,
    notes: [
      'The token is checked at call time, not at initialize.',
      'AU workspaces are unsupported; add_internal_note needs the "Write conversations" scope.',
    ],
    sendTools: ['add_internal_note'],
  },
  {
    id: 'intercom-eu',
    title: 'Intercom (EU)',
    category: 'crm',
    name: 'intercom',
    kind: 'http',
    config: { url: 'https://mcp.eu.intercom.com/mcp', headers: {} },
    auth: bearer('Intercom access token'),
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    source: 'Intercom',
    installable: true,
    keylessAtInitialize: true,
    notes: ['The EU region of the same server; the same caveats apply.'],
    sendTools: ['add_internal_note'],
  },
  {
    id: 'atlassian',
    title: 'Atlassian (Jira, Confluence)',
    category: 'work',
    name: 'atlassian',
    kind: 'http',
    config: { url: 'https://mcp.atlassian.com/v2/mcp', headers: {} },
    auth: bearer('Service-account API key'),
    docsUrl: 'https://support.atlassian.com/atlassian-ai-gateway/docs/configure-authentication-via-api-token/',
    source: 'Atlassian',
    installable: true,
    notes: [
      'v2, never v1: v1 accepts a garbage token at initialize and only refuses on a call.',
      'A personal token uses Basic auth, which the worker cannot inject; use a service-account key.',
      'Only if enabled by the organisation admin.',
    ],
    sendTools: [],
  },
  {
    id: 'zapier',
    title: 'Zapier MCP',
    category: 'work',
    name: 'zapier',
    kind: 'http',
    config: { url: 'https://mcp.zapier.com/api/v1/connect', headers: {} },
    auth: bearer('Zapier connection token'),
    docsUrl: 'https://docs.zapier.com/mcp/get-started/quickstart',
    source: 'Zapier MCP',
    installable: true,
    notes: [
      'Every tool is a side effect on another SaaS, so every tool is on the disable list.',
      'Never the query-parameter or /api/mcp/s/<id>/mcp forms: both carry the secret in the URL.',
    ],
    sendTools: ['*'],
  },
  {
    id: 'github',
    title: 'GitHub (read-only)',
    category: 'engineering',
    name: 'github',
    kind: 'http',
    config: { url: 'https://api.githubcopilot.com/mcp/readonly', headers: {} },
    auth: bearer('Fine-grained personal access token'),
    docsUrl: 'https://github.com/github/github-mcp-server',
    source: 'GitHub',
    installable: true,
    notes: ['A malformed token answers 400, not 401 — it expects a real PAT shape.'],
    sendTools: [],
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare',
    category: 'engineering',
    name: 'cloudflare',
    kind: 'http',
    config: { url: 'https://mcp.cloudflare.com/mcp', headers: {} },
    auth: bearer('Cloudflare API token'),
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    source: 'Cloudflare',
    installable: true,
    notes: ['The unified server; the per-product radar/bindings/observability servers are deprecated.'],
    sendTools: [],
  },
  {
    id: 'cloudflare-docs',
    title: 'Cloudflare docs',
    category: 'engineering',
    name: 'cloudflare-docs',
    kind: 'http',
    config: { url: 'https://docs.mcp.cloudflare.com/mcp', headers: {} },
    auth: { cls: 'none', needsCredential: false, credentialLabel: 'none' },
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    source: 'Cloudflare',
    installable: true,
    notes: ['No authentication; documentation search only.'],
    sendTools: [],
  },
  {
    id: 'neon',
    title: 'Neon',
    category: 'engineering',
    name: 'neon',
    kind: 'http',
    config: { url: 'https://mcp.neon.tech/mcp', headers: {} },
    auth: bearer('Neon API key (read-only)'),
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    source: 'Neon',
    installable: true,
    notes: [
      'Never connect MCP agents to production databases — this product’s live database is one. A read-only key, or nothing.',
      'The stdio package takes the key on the command line and is not offered.',
    ],
    sendTools: [],
  },
  {
    id: 'stripe',
    title: 'Stripe',
    category: 'engineering',
    name: 'stripe',
    kind: 'http',
    config: { url: 'https://mcp.stripe.com', headers: {} },
    auth: bearer('Agent API key'),
    docsUrl: 'https://docs.stripe.com/mcp',
    source: 'Stripe',
    installable: true,
    notes: [
      'From 31 October 2026 only keys carrying the Agent tag are accepted.',
      'The tools that move money or send an invoice are on the disable list; names as documented.',
    ],
    sendTools: ['create_refund', 'create_payment_link', 'create_invoice', 'finalize_invoice', 'create_payout'],
  },
  // -------------------------------------------------------------------------
  // Class B — a named header or scheme (needs secretHeader / secretPrefix).
  // -------------------------------------------------------------------------
  {
    id: 'hunter',
    title: 'Hunter.io',
    category: 'crm',
    name: 'hunter',
    kind: 'http',
    config: { url: 'https://mcp.hunter.io/mcp', headers: {}, secretHeader: 'x-api-key', secretPrefix: '' },
    auth: { cls: 'named-header', needsCredential: true, credentialLabel: 'Hunter API key' },
    docsUrl: 'https://hunter.io/mcp',
    source: 'Hunter.io',
    installable: true,
    notes: ['The key goes in X-API-Key; Bearer is accepted by observation only and not documented.'],
    sendTools: [],
  },
  {
    id: 'apollo',
    title: 'Apollo.io',
    category: 'crm',
    name: 'apollo',
    kind: 'http',
    config: { url: 'https://mcp.apollo.io/mcp', headers: {}, secretHeader: 'x-api-key', secretPrefix: '' },
    auth: { cls: 'named-header', needsCredential: true, credentialLabel: 'Apollo master API key' },
    docsUrl: 'https://docs.apollo.io/docs/apollo-mcp',
    source: 'Apollo.io',
    installable: true,
    notes: [
      'Master key only: a scoped key is rejected with API_INACCESSIBLE.',
      'Never use its sequences — they send mail outside the single send path. Every tool is on the disable list.',
    ],
    sendTools: ['*'],
  },
  {
    id: 'close',
    title: 'Close',
    category: 'crm',
    name: 'close',
    kind: 'http',
    config: {
      url: 'https://mcp.close.com/mcp',
      headers: { 'close-scope': 'mcp.read' },
      secretHeader: 'close-api-key',
      secretPrefix: '',
    },
    auth: { cls: 'named-header', needsCredential: true, credentialLabel: 'Close API key' },
    docsUrl: 'https://developer.close.com/mcp',
    source: 'Close',
    installable: true,
    notes: [
      'The Close-Scope header is set to mcp.read; change it to mcp.write_safe only with the writes in mind.',
      'HTTP Streamable only; no SSE.',
    ],
    sendTools: [],
  },
  {
    id: 'pipedrive',
    title: 'Pipedrive',
    category: 'crm',
    name: 'pipedrive',
    kind: 'http',
    config: { url: 'https://mcp.pipedrive.ai/mcp', headers: {}, secretHeader: 'x-api-token', secretPrefix: '' },
    auth: { cls: 'named-header', needsCredential: true, credentialLabel: 'Pipedrive API token' },
    docsUrl: 'https://support.pipedrive.com/en/article/mcp-claude',
    source: 'Pipedrive',
    installable: true,
    keylessAtInitialize: true,
    notes: [
      'Plausible, not confirmed: Test connection succeeds with any value, and even tools/list answers; only a tool call proves the token.',
    ],
    sendTools: [],
  },
  {
    id: 'sentry',
    title: 'Sentry',
    category: 'engineering',
    name: 'sentry',
    kind: 'http',
    config: {
      url: 'https://mcp.sentry.dev/mcp',
      headers: {},
      secretHeader: 'authorization',
      secretPrefix: 'Sentry-Bearer ',
    },
    auth: { cls: 'named-header', needsCredential: true, credentialLabel: 'Sentry access token' },
    docsUrl: 'https://mcp.sentry.dev',
    source: 'Sentry',
    installable: true,
    keylessAtInitialize: true,
    notes: [
      'Sentry-Bearer is intentionally separate from Bearer, which the server reserves for OAuth tokens.',
      'A garbage token is accepted at initialize.',
    ],
    sendTools: [],
  },
  // -------------------------------------------------------------------------
  // Class D — stdio, the credential injected under a named variable.
  // -------------------------------------------------------------------------
  {
    id: 'brave',
    title: 'Brave Search',
    category: 'research',
    name: 'brave',
    kind: 'stdio',
    config: {
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
      env: {},
      secretEnv: 'BRAVE_API_KEY',
    },
    auth: { cls: 'stdio-env', needsCredential: true, credentialLabel: 'Brave Search API key' },
    docsUrl: 'https://github.com/brave/brave-search-mcp-server',
    source: 'Brave Search',
    installable: true,
    notes: [
      STDIO_CAVEAT,
      'The package’s HTTP endpoint is unauthenticated — never expose it; stdio only.',
    ],
    sendTools: [],
  },
  {
    id: 'snyk',
    title: 'Snyk',
    category: 'engineering',
    name: 'snyk',
    kind: 'stdio',
    config: { command: 'npx', args: ['-y', 'snyk@latest', 'mcp', '-t', 'stdio'], env: {}, secretEnv: 'SNYK_TOKEN' },
    auth: { cls: 'stdio-env', needsCredential: true, credentialLabel: 'Snyk API token' },
    docsUrl: 'https://docs.snyk.io/agent-security',
    source: 'Snyk',
    installable: true,
    notes: [STDIO_CAVEAT, 'Installs a lot on the worker host. Snyk offers no hosted server.'],
    sendTools: [],
  },
  {
    id: 'semgrep',
    title: 'Semgrep',
    category: 'engineering',
    name: 'semgrep',
    kind: 'stdio',
    config: { command: 'uvx', args: ['semgrep-mcp'], env: {}, secretEnv: 'SEMGREP_APP_TOKEN' },
    auth: {
      cls: 'stdio-env',
      needsCredential: false,
      credentialLabel: 'Semgrep app token',
      optional: true,
    },
    docsUrl: 'https://github.com/semgrep/mcp',
    source: 'Semgrep',
    installable: true,
    notes: [
      STDIO_CAVEAT,
      'uvx must exist on the worker image. The token is only needed for semgrep_findings; local scans need none.',
      'The hosted server contradicts its own README and is not offered.',
    ],
    sendTools: [],
  },
  {
    id: 'sentry-stdio',
    title: 'Sentry (stdio)',
    category: 'engineering',
    name: 'sentry',
    kind: 'stdio',
    config: { command: 'npx', args: ['-y', '@sentry/mcp-server@latest'], env: {}, secretEnv: 'SENTRY_ACCESS_TOKEN' },
    auth: { cls: 'stdio-env', needsCredential: true, credentialLabel: 'Sentry access token' },
    docsUrl: 'https://mcp.sentry.dev',
    source: 'Sentry',
    installable: true,
    notes: [
      STDIO_CAVEAT,
      'The env var, never the --access-token flag: the flag is visible in ps.',
    ],
    sendTools: [],
  },
  // -------------------------------------------------------------------------
  // Class C — OAuth only. Listed under "needs a connect flow, not built".
  // -------------------------------------------------------------------------
  {
    id: 'hubspot',
    title: 'HubSpot',
    category: 'crm',
    name: 'hubspot',
    kind: 'http',
    config: { url: 'https://mcp.hubspot.com', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://developers.hubspot.com/',
    source: 'HubSpot',
    installable: false,
    notes: ['OAuth 2.1 with PKCE against an MCP connector app the customer creates; refresh tokens required.'],
    sendTools: [],
  },
  {
    id: 'attio',
    title: 'Attio',
    category: 'crm',
    name: 'attio',
    kind: 'http',
    config: { url: 'https://mcp.attio.com/mcp', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://docs.attio.com/mcp/overview',
    source: 'Attio',
    installable: false,
    notes: ['OAuth only — "no API keys required".'],
    sendTools: [],
  },
  {
    id: 'slack',
    title: 'Slack',
    category: 'work',
    name: 'slack',
    kind: 'http',
    config: { url: 'https://mcp.slack.com/mcp', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    source: 'Slack',
    installable: false,
    notes: ['OAuth user token from a registered Slack app; only Marketplace and internal apps may use MCP.'],
    sendTools: [],
  },
  {
    id: 'notion',
    title: 'Notion',
    category: 'work',
    name: 'notion',
    kind: 'http',
    config: { url: 'https://mcp.notion.com/mcp', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    source: 'Notion',
    installable: false,
    notes: ['Hosted is OAuth only; the stdio package is unmaintained and not offered.'],
    sendTools: [],
  },
  {
    id: 'asana',
    title: 'Asana',
    category: 'work',
    name: 'asana',
    kind: 'http',
    config: { url: 'https://mcp.asana.com/v2/mcp', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://developers.asana.com/docs/integrating-with-asanas-mcp-server',
    source: 'Asana',
    installable: false,
    notes: ['OAuth 2.0 with a registered client; personal access tokens are rejected at the protocol level.'],
    sendTools: [],
  },
  {
    id: 'calcom',
    title: 'Cal.com',
    category: 'scheduling',
    name: 'calcom',
    kind: 'http',
    config: { url: 'https://mcp.cal.com/mcp', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://cal.com/docs/mcp-server',
    source: 'Cal.com',
    installable: false,
    notes: ['Hosted is OAuth 2.1 only; the stdio package is "subject to rapid changes" and not offered.'],
    sendTools: [],
  },
  {
    id: 'calendly',
    title: 'Calendly',
    category: 'scheduling',
    name: 'calendly',
    kind: 'http',
    config: { url: 'https://mcp.calendly.com', headers: {} },
    auth: oauthOnly,
    docsUrl: 'https://developer.calendly.com/docs/mcp/calendly-mcp-server',
    source: 'Calendly',
    installable: false,
    notes: ['OAuth 2.1 with dynamic client registration only; no client secret, no self-hosting.'],
    sendTools: [],
  },
])

/** One preset by id, or null. */
export function presetById(id: string): ConnectorPreset | null {
  return CONNECTOR_CATALOG.find((p) => p.id === id) ?? null
}

/**
 * Presets whose server accepts a wrong credential at initialize, so a green
 * Test connection proves the endpoint answers and nothing about the key.
 */
export const KEYLESS_AT_INITIALIZE: readonly string[] = Object.freeze(
  CONNECTOR_CATALOG.filter((p) => p.keylessAtInitialize).map((p) => p.id),
)
