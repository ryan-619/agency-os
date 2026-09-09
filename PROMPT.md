# Build Spec — Agency OS

**How to use this file.** Put it at the root of an empty git repo, open Claude Code there, and say:

> Read PROMPT.md. Build Phase 0 only. Stop when Phase 0's Definition of Done passes and show me the diff.

Then run one phase at a time. Do not ask for the whole thing in one go — the phases are ordered so each one is independently useful and independently reviewable.

---

## 1. What you are building

An internal operating system for a two-to-five person software agency that sells **application security and DevSecOps engagements**. It runs the funnel end to end: find companies, qualify them on evidence, reach out, hold conversations across email / SMS / WhatsApp / voice, and carry a deal to a signed client.

The defining feature is not the CRM. It is that **the app's own chat panel is a full Claude agent** with access to the company's MCP servers, skills, and internal tools — so a team member can type "find me twenty more companies like Rentman and draft openers" and it happens, inside the product, with the results landing in the database rather than in a chat transcript.

**Users:** the agency's own team. Single organization. No billing, no signup flow, no marketing site.

**You are the second engineer on this project.** The first one (this spec) made the architectural decisions. Follow them. Where this spec is silent, choose the boring option and leave a comment saying you chose it.

---

## 2. Hard constraints — read before writing any code

These are not preferences. Violating them creates legal exposure or destroys the product's value.

### 2.1 Outreach compliance

- **Cold outreach is email and LinkedIn only.** The system must make it structurally impossible to place a cold outbound call or send a cold SMS. Voice and SMS are for **inbound** contacts and contacts with a recorded opt-in, full stop.
- Every contact row carries a `consent` record. `sms_consent` and `voice_consent` are separate booleans with a `source` and `recorded_at`. A send/dial attempt without the matching consent must fail loudly at the service layer, not be caught by UI validation.
- AI voice calls disclose that they are AI at the start of the call, and offer an interactive opt-out. This is a US TCPA requirement (the FCC classified AI-generated voice as "artificial voice" in Feb 2024), not a nicety.
- Quiet hours are enforced server-side in the **recipient's** timezone, not the sender's.
- A `suppression` table wins over everything. One row there and no channel may ever contact that address, number, or domain again. Check it in the send path, not the campaign builder.

### 2.2 Evidence integrity

The product's whole credibility rests on this: **the app must never state a security finding it did not actually observe.**

- Every finding row carries `observed: boolean`. A fetch failure, timeout, WAF block, or CDN quirk produces `observed: false`, which scores zero and is **never** rendered as a gap.
- Findings carry the raw evidence that produced them (the header value seen, the URL fetched, the timestamp).
- Findings older than 14 days are marked stale and must be re-verified before appearing in any outbound draft.
- The scanner reads **public pages only**: homepage response headers, `/.well-known/security.txt`, `/security`, `/trust`, the TLS certificate, and script tags on the homepage. No port scanning. No probing for `.git`, `.env`, admin panels, or backups. This is posture review from the outside, not a security test, and every piece of copy in the app must describe it that way.

### 2.3 Secrets

- No credential is ever written to a source file, a log line, or an agent's context window.
- Third-party credentials (Twilio, Apollo, SMTP, MCP server tokens) live encrypted at rest in Postgres using a KMS key or a libsodium sealed box with the master key in the environment. Decrypt at point of use only.
- The agent must never be handed a raw API key. It calls internal tools; the tool implementation reads the credential server-side.

### 2.4 Irreversible actions need a human

Anything that leaves the building — sending an email, placing a call, sending an SMS, writing to a client-facing system — goes through an **approval queue** unless a team member has explicitly enabled auto-send for that specific campaign. Implement this with the SDK's `canUseTool` callback (§5.4), not with UI-layer discipline.

---

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript, strict mode, everywhere | |
| Web app | Next.js (App Router) | UI + BFF routes |
| Agent service | Node worker, separate process | Long-running; the web app must not block on agent turns |
| Voice service | Node, separate process | Twilio ConversationRelay WebSocket; latency-critical, isolate it |
| Database | Postgres 16 | The system of record |
| Queue | pg-boss (Postgres-backed) | Do not add Redis until Postgres is genuinely the bottleneck |
| Realtime to browser | SSE | Simpler than WebSockets for one-way streaming; use WS only for the voice service |
| Auth | Auth.js, email magic link | Internal tool, small team |
| Migrations | Drizzle or Prisma | Pick one, commit to it |
| Deploy | Docker Compose on a single VPS | Self-hosted. Lead data stays on the agency's hardware. |

**Monorepo layout:**

```
apps/
  web/          Next.js UI + API routes
  agent/        Agent SDK worker
  voice/        ConversationRelay WebSocket server
packages/
  db/           schema, migrations, typed queries
  core/         domain logic: scoring, consent, suppression, evidence
  scanner/      the public-surface signal collector
  tools/        internal MCP tool definitions the agent calls
```

`packages/core` must have no dependency on Next.js, the Agent SDK, or any HTTP framework. Domain rules are testable in isolation. This is the one architectural rule worth being pedantic about.

---

## 4. Data model

Write this as migrations. Every table gets `id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz`.

Include an `org_id uuid not null` on every business table **even though there is exactly one organization today**. It costs nothing now and saves a full migration if this is ever sold to another agency. Default it to a single seeded org row.

```
users            id, org_id, email, name, role (owner|member), created_at
                 role gates: only owner can edit connectors and credentials

icp_profiles     id, org_id, name, definition jsonb, active
                 definition holds firmographics, signal weights, qualify_at,
                 tier boundaries, disqualifiers, outreach rules.
                 Seed with the security-gap SaaS ICP in §11.

companies        id, org_id, domain unique, name, country, stage, headcount,
                 title, source (apollo|manual|import|agent), first_seen_at

scans            id, company_id, ran_at, ok bool, error text,
                 raw jsonb          -- full response headers, TLS info, script srcs

findings         id, scan_id, company_id, signal_key, observed bool,
                 gap bool, weight int, detail text, evidence jsonb, stale bool
                 UNIQUE (scan_id, signal_key)

scores           id, company_id, icp_profile_id, score int, tier text,
                 qualified bool, disqualified_reason text, computed_at
                 Recompute on every scan; keep history, never overwrite.

contacts         id, company_id, first_name, last_name, title, email, phone,
                 linkedin_url, source, verified_at

consents         id, contact_id, channel (email|sms|voice|whatsapp),
                 granted bool, source text, recorded_at, evidence jsonb
                 One row per channel per contact. Absence means NO.

suppressions     id, org_id, kind (email|domain|phone), value, reason,
                 created_at
                 UNIQUE (org_id, kind, value). Checked in every send path.

campaigns        id, org_id, name, icp_profile_id, channel, auto_send bool
                 default false, daily_cap int default 25, quiet_start,
                 quiet_end, status

touches          id, campaign_id, contact_id, channel, direction (out|in),
                 status (queued|awaiting_approval|approved|sent|delivered|
                 bounced|replied|failed), subject, body, provider_id,
                 scheduled_for, sent_at, error
                 The single log of every message in either direction.

calls            id, contact_id, direction, provider_call_sid, started_at,
                 ended_at, duration_s, recording_url, transcript jsonb,
                 summary text, outcome, sentiment, handoff_to_user_id

deals            id, company_id, stage (new|contacted|replied|meeting|
                 proposal|won|lost), value_cents, currency, owner_user_id,
                 next_action, next_action_at, closed_at, lost_reason

approvals        id, org_id, requested_by (agent|user id), tool_name,
                 payload jsonb, risk (low|medium|high), status
                 (pending|approved|denied|expired), decided_by, decided_at,
                 expires_at
                 The human-in-the-loop gate. §5.4.

connectors       id, org_id, name, kind (stdio|http|sse), enabled bool,
                 config jsonb, secret_ref text, created_by, last_ok_at,
                 last_error
                 Runtime MCP server registry. §6. This is what makes the
                 tool set customizable without a redeploy.

agent_defs       id, org_id, slug unique, name, description, system_prompt,
                 tools text[], model text, enabled bool
                 Subagents as data. §7.

chat_sessions    id, org_id, user_id, sdk_session_id, title, archived,
                 last_active_at

chat_messages    id, session_id, role (user|assistant|tool|system),
                 content jsonb, tool_name, tokens_in, tokens_out,
                 cost_usd numeric, created_at

audit_log        id, org_id, actor (user id or 'agent'), action, subject_type,
                 subject_id, detail jsonb, created_at
                 Every state change that touches a person outside the company.
```

**Indexes that matter:** `companies(org_id, domain)`, `touches(campaign_id, status, scheduled_for)`, `findings(company_id, stale)`, `suppressions(org_id, kind, value)`, `approvals(org_id, status)`.

---

## 5. The agent runtime — the core of the product

Package: **`@anthropic-ai/claude-agent-sdk`**. Entry point is `query()`, which returns an async generator. There is no class to instantiate.

Auth is `ANTHROPIC_API_KEY` in the environment. Subscription login is not available to third-party products — do not attempt it.

### 5.1 Minimal shape

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: userText,
  options: {
    systemPrompt: { type: "preset", preset: "claude_code", append: ORG_CONTEXT },
    mcpServers,           // built at runtime from the connectors table — §6
    agents,               // built at runtime from agent_defs — §7
    allowedTools,
    canUseTool,           // the approval gate — §5.4
    includePartialMessages: true,
    maxTurns: 30,
    maxBudgetUsd: 2.0,
    resume: sdkSessionId, // continuity across HTTP requests — §5.3
  },
})) {
  // handle message
}
```

### 5.2 Streaming to the browser

With `includePartialMessages: true` you receive `stream_event` messages before each complete `AssistantMessage`. Relay them over SSE.

```ts
if (
  message.type === "stream_event" &&
  message.event.type === "content_block_delta" &&
  message.event.delta.type === "text_delta"
) {
  sse.send({ kind: "text", text: message.event.delta.text });
}
```

The event sequence per turn is `message_start` → `content_block_start` → many `content_block_delta` → `content_block_stop` → complete `AssistantMessage` → tool results → repeat → final `ResultMessage` (`message.type === "result"`).

Persist to `chat_messages` on the complete `AssistantMessage`, not on every delta. Capture `session_id` and cost from the final `result` message.

### 5.3 Session continuity

HTTP is stateless; agent conversations are not.

- Capture `message.session_id` from the `result` message, store it on `chat_sessions.sdk_session_id`.
- Next request in that thread passes `resume: sdkSessionId`.
- `forkSession: true` alongside `resume` branches without mutating the original — use it for "try a different angle on this lead" without losing the thread.

The SDK writes transcripts to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` by default. That is fine on a single VPS. If the agent worker is ever replicated, implement a `SessionStore` adapter backed by Postgres — the SDK accepts one via the `sessionStore` option and mirrors transcripts on every turn.

### 5.4 The approval gate

This is the most important integration in the app.

```ts
const canUseTool = async (toolCall) => {
  const risk = classifyRisk(toolCall);            // in packages/core
  if (risk === "low") return { allow: true };

  const approval = await createApproval({
    toolName: toolCall.name,
    payload: toolCall.input,
    risk,
    expiresAt: addMinutes(new Date(), 30),
  });
  notifyTeam(approval);
  const decision = await waitForDecision(approval.id, { timeoutMs: 30 * 60_000 });

  return decision === "approved"
    ? { allow: true }
    : { allow: false, reason: `Not approved by a human (${decision})` };
};
```

Risk classification lives in `packages/core` and is a pure function:

- **low** — reads: query the database, fetch a public page, run a scan, search the web.
- **medium** — writes inside the system: create a campaign, change a deal stage, write a draft.
- **high** — anything leaving the building: send email, send SMS, place a call, write to a third-party system. Always requires a human unless the campaign has `auto_send = true` **and** the recipient has the matching consent **and** the suppression check passes.

Never set `permissionMode: "bypassPermissions"` in this application. It exists in the SDK and it is wrong here — it would let an agent send mail on its own judgment.

Also register `PreToolUse` and `PostToolUse` hooks to write every tool call into `audit_log`. Approval decides; the audit log remembers.

### 5.5 "Claude and other AIs" — be precise about the seam

The Agent SDK runs Claude. Do not pretend otherwise in the code or the UI. Two honest paths for other models:

1. **Non-agentic work goes through a provider abstraction.** Scoring, classification, summarising a transcript, drafting one email body — these are single-shot calls with no tool use. Put them behind `packages/core/llm/provider.ts` with implementations for Anthropic, OpenAI, and a local **Ollama** endpoint. The agency runs Ollama already; local models keep lead data on their hardware, which is the point.

2. **The Agent SDK itself can be pointed at Bedrock, Vertex, or Foundry** via env flags (`CLAUDE_CODE_USE_BEDROCK=1` and similar). That changes the hosting, not the model family.

In the UI, let the user pick a model per task type. Label the agentic chat as Claude, because it is.

---

## 6. Runtime connector registry — how the tool set stays customizable

**This is the requirement that makes the product what it was asked for: new tools must be addable from inside the software, without a code change or a redeploy.**

The `connectors` table is a registry of MCP servers. On every agent session, build the `mcpServers` option from the enabled rows.

```ts
function buildMcpServers(rows: Connector[]) {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.kind === "stdio") {
      out[r.name] = { command: r.config.command, args: r.config.args };
    } else {
      out[r.name] = {
        type: r.kind,                              // "http" | "sse"
        url: r.config.url,
        headers: withDecryptedSecrets(r.secret_ref, r.config.headers),
      };
    }
  }
  return out;
}
```

MCP tools are named `mcp__<server-name>__<tool-name>`, and `allowedTools` accepts wildcards — `mcp__apollo__*` auto-approves a whole server. Use that, combined with the risk classifier, rather than enumerating tools by hand.

**Also build an in-process MCP server for the app's own domain tools** using `createSdkMcpServer` and `tool()` from the SDK, with zod schemas. This is how the agent reaches the database — never by writing SQL through a Bash tool.

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const agencyTools = createSdkMcpServer({
  name: "agency",
  version: "1.0.0",
  tools: [
    tool("search_companies", "Find companies in the CRM by filters",
      { query: z.string(), minScore: z.number().optional() },
      async (input) => ({ content: [{ type: "text", text: await searchCompanies(input) }] })),
    tool("scan_company", "Run the public-surface scan on a domain",
      { domain: z.string() }, async ({ domain }) => …),
    tool("score_company", "Score a company against an ICP profile", …),
    tool("draft_outreach", "Draft an opener from a company's findings", …),
    tool("queue_touch", "Queue a message for approval and sending", …),
    tool("get_pipeline", "Read the deal pipeline", …),
    tool("update_deal", "Move a deal stage or set next action", …),
    tool("book_meeting", "Create a calendar event", …),
  ],
});
```

**Admin UI — Settings → Connectors.** A form to add an MCP server: name, transport, command/args or URL, headers, secrets. A "Test connection" button that starts a throwaway session, lists the server's tools, writes `last_ok_at` or `last_error`, and shows the tool list. An enable/disable toggle. This screen is what "add more tools later" actually means.

**Skills are filesystem-only** in the SDK — they cannot be registered programmatically. Mount a `skills/` volume into the agent container and set `settingSources: ["project"]`, `skills: "all"`, and include `"Skill"` in `allowedTools`. Give the UI a way to upload a `SKILL.md` folder into that volume, and document the constraint rather than faking a database-backed skill registry.

---

## 7. Agents as data

`agent_defs` rows map onto the SDK's `agents` option, which takes definitions programmatically:

```ts
const agents = Object.fromEntries(rows.map((r) => [r.slug, {
  description: r.description,   // the model reads this to decide when to delegate
  prompt: r.system_prompt,
  tools: r.tools,               // optional; omit for all subagent tools
  model: r.model,               // optional override, e.g. "sonnet" for cheap work
}]));
```

Include `"Agent"` in `allowedTools` so delegation does not stall on approval.

Seed these four and let the team add more from **Settings → Agents**:

- **prospector** — given an ICP, finds candidate companies via the connected sourcing servers and writes them to `companies`. Tools: sourcing MCP servers + `mcp__agency__*`. Model: sonnet.
- **qualifier** — scans and scores companies, writes findings honouring the `observed` rule. Tools: `scan_company`, `score_company`. Model: sonnet.
- **researcher** — reads a specific company deeply and produces the angle and the personalised opener. Tools: web fetch, `mcp__agency__*`.
- **closer** — drafts proposals from findings, prepares meeting briefs, drafts follow-ups. Never sends.

Set `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` in the worker's env. A prospector fanning out unbounded will hit rate limits and burn budget.

---

## 8. Feature modules

### 8.1 Chat (the headline feature)

Full-height panel, present on every screen. Streams tokens. Renders tool calls as collapsible cards showing the tool name, input, and result — the user must be able to see what the agent actually did, not just its summary.

Inline approval cards: when `canUseTool` creates a pending approval, the chat renders Approve / Deny with the full payload visible. Approving resolves the promise the agent is awaiting and the turn continues.

Context awareness: the current record is passed in the prompt preamble, so "draft an opener for this one" works without the user restating which company they mean.

Show running cost per session from the `result` message. A team that cannot see cost will not trust the tool.

### 8.2 Sourcing

Import a CSV of domains. Or ask the prospector agent. Or pull from a connected sourcing server. Deduplicate on domain at write time, not at read time.

### 8.3 Scanning and scoring

Port `packages/scanner` from the existing Python engine at `~/Documents/lead-engine`. **Read that code first** — the rules encoded in it are the product, particularly the `observed` handling and the disqualifier ordering. The signal set, weights, and tier boundaries move into `icp_profiles.definition` so they are editable in the UI.

Disqualifiers run before scoring: unreachable, sells security itself, already has an in-house security function, no web-facing product.

Rescan on a schedule; mark findings stale at 14 days.

### 8.4 Outreach

Campaign builder: ICP filter, channel, daily cap, quiet hours, auto-send toggle (default off).

Send path, in this order, every time, no exceptions: suppression check → consent check → quiet-hours check → daily-cap check → approval gate → provider send → write `touches` → write `audit_log`. Put this in one function in `packages/core`. Every channel calls it. There must be exactly one code path that can cause a message to leave the building.

Email via SMTP over the agency's warmed mailboxes; SendGrid behind the same interface for later volume. Reply detection via IMAP IDLE or the provider webhook — an inbound reply flips the deal to `replied` and pauses the sequence for that contact immediately.

### 8.5 Voice

Separate `apps/voice` service. Twilio ConversationRelay hands you a WebSocket; you run the conversation loop against the model and stream back.

Inbound and opted-in only — enforced in the dial path, not the UI. AI disclosure in the first utterance. Interactive opt-out honoured immediately and written to `suppressions`. Warm handoff to a human via TaskRouter when intent or sentiment crosses a threshold. Transcript, summary, sentiment and outcome written to `calls` when the call ends.

Budget note for the UI: ConversationRelay is roughly $0.07/min plus about $0.014/min outbound. Show projected cost before a campaign dials.

### 8.6 Pipeline, calendar, proposals

Kanban over `deals.stage`. Drag to move, which writes `audit_log`.

Calendar via the Google Calendar MCP server registered as a connector. Booking links land inbound leads with consent recorded at the form.

Proposals generate from findings — the assessment scope writes itself from what the scan already found.

---

## 9. Build phases

Ship each phase completely. Do not start the next until the Definition of Done passes.

**Phase 0 — Foundation.** Monorepo, Docker Compose (Postgres + web + agent), schema and migrations, Auth.js magic link, seeded org and owner user, health checks, CI running typecheck + tests.
*Done when:* `docker compose up` gives a login, a session, and an empty dashboard; migrations run clean from zero.

**Phase 1 — Data core.** Companies, contacts, findings, scores. Port the scanner. CSV import. Company detail page showing findings with their evidence.
*Done when:* importing the 16 seed domains from `~/Documents/lead-engine/seeds/` produces scored companies whose findings match what the Python engine produces for the same domains. **Write that comparison as a test.**

**Phase 2 — The agent.** Agent worker, `query()` loop, SSE streaming, chat UI, `chat_sessions` and resume, the in-process `agency` MCP server, `canUseTool` with the approval queue, audit logging.
*Done when:* a user types "score the companies in the pipeline and tell me the top three by fit" and it works end to end, with tool cards visible, cost shown, and a high-risk tool correctly blocking on approval.

**Phase 3 — Connectors and agents as data.** Settings → Connectors with test-connection. Settings → Agents. Runtime assembly of `mcpServers` and `agents`. Skills volume.
*Done when:* the owner adds an MCP server through the UI and the agent uses one of its tools in the very next chat message, with no restart.

**Phase 4 — Email outreach.** Campaigns, the single send path, approval queue UI, reply detection, suppression management, daily caps and quiet hours.
*Done when:* a campaign drafts, queues, waits for approval, sends through a real mailbox, and an inbound reply pauses the sequence and moves the deal. **Plus:** a test proving a send is refused when suppression, consent, quiet hours, or cap would be violated — one test per rule.

**Phase 5 — Pipeline and closing.** Kanban, calendar, proposals, meeting briefs.
*Done when:* a replied lead can be dragged to meeting, booked, and a proposal generated from its findings.

**Phase 6 — Voice and SMS.** Only after A2P 10DLC registration has cleared. Voice service, ConversationRelay, consent enforcement, transcripts, handoff.
*Done when:* an inbound call is answered by the agent, discloses AI, qualifies, hands off to a human, and writes a transcript and summary.

---

## 10. Engineering standards

- TypeScript strict. No `any` that survives review. Zod at every boundary — HTTP handlers, agent tool inputs, provider webhooks.
- Domain rules in `packages/core` with unit tests and no I/O. Consent, suppression, quiet hours, scoring and risk classification are all pure functions and all must be tested against their edge cases.
- Integration tests for the send path. This is where a bug becomes a legal problem.
- Structured logging with a request/session id. Never log credentials or full message bodies.
- Every migration reversible. Never edit a shipped migration.
- Conventional commits, small PRs, one phase per branch.
- A `README.md` a new engineer can follow to a running system in under ten minutes.
- Keep a `CLAUDE.md` at the repo root with the architecture, the invariants from §2, and the commands. Update it as you build — it is what future Claude Code sessions read first.

---

## 11. Seed data

Seed one ICP profile: **Security-gap SaaS (US/EU)**.

Firmographics: 15–400 employees; US, CA, UK, DE, NL, SE, IE, FR, ES, PT, PL; seed through Series B or bootstrapped-profitable; web-facing SaaS with a login; sells B2B.

Signals and weights: `csp` 15, `trust_page` 14, `compliance_claim` 12, `security_txt` 12, `hsts` 10, `outdated_js` 10, `frame_protection` 8, `tls` 8, `server_banner` 7, `content_type_options` 5, `referrer_policy` 4, `permissions_policy` 3.

Scoring: normalise to 0–100 over the weights of **observed** signals only. Qualify at 45. Tiers: A ≥ 70, B ≥ 55, C ≥ 45.

Disqualifiers: unreachable; sells security; has in-house security; no public product.

Outreach: channels `[email, linkedin]`, 25/day cap, auto-send off. Opener rule — one specific verifiable finding, one consequence, one ask; never a numeric score; never imply anything private was accessed.

Seed the 16 companies in `~/Documents/lead-engine/seeds/security-gap-saas.txt`.

---

## 12. Do not

- Do not build a marketing site, a signup flow, billing, or multi-tenancy. One org, seeded.
- Do not build a custom agent loop. The SDK is the loop.
- Do not give the agent database credentials, a raw SQL tool, or shell access to production. It gets typed tools.
- Do not let cold voice or cold SMS become reachable through any code path, including "just for testing".
- Do not render a finding whose `observed` is false.
- Do not add Redis, Kafka, a vector database, or a microservice split. Postgres and three processes.
- Do not use `permissionMode: "bypassPermissions"`.
- Do not build Phase 6 before the A2P registration clears — the code will sit unused for weeks and rot.
- Do not scaffold all seven phases at once. One phase, reviewed, merged, then the next.

---

## 13. Where this spec is uncertain

Flag rather than guess:

- **SDK option keys drift.** The APIs above (`query`, `mcpServers`, `agents`, `canUseTool`, `resume`, `forkSession`, `includePartialMessages`, `maxTurns`, `maxBudgetUsd`, `settingSources`, `skills`, `createSdkMcpServer`, `tool`, `sessionStore`) were checked against the official docs in September 2026. **Verify against the installed package's own types before building on any of them.** If a name has changed, follow the types and note it in `CLAUDE.md`.
- **`sessionStore`** is documented for multi-host deployments but is only needed if the agent worker is replicated. Single VPS does not need it.
- Twilio prices and A2P fees in this document are September 2026 US list prices and will drift. Read them from config, never hardcode them into UI copy.
