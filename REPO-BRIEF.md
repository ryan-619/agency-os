# Agency OS — what this repo is and what it can do

A briefing for a session picking this up cold. Written 2026-09-27.

Read this first, then `CLAUDE.md` (1,500 lines — decisions, deviations and the
bugs that have already been found the hard way) and `PROMPT.md` (the build
spec). `DEPLOYING.md` is the deployment reference; `GO-LIVE.md` is the live
runbook with the current state of the domain and mail.

Repo: https://github.com/ryan-619/agency-os (public, default branch `main`)

---

## 1. What it is

An internal operating system for a **3–4 person application-security agency**.
Not a SaaS, not multi-tenant, no signup and no billing: one seeded org, a few
named users, and a product whose entire job is to run that agency's pipeline
from "we have never heard of this company" to "we sent them a proposal".

The loop it automates:

```
company → scanned from the outside → scored against an ICP
   → the agent researches and drafts → a HUMAN approves
   → one send path → reply detected → deal moves → proposal from findings
```

Two things make it different from a generic CRM, and both are enforced in code
rather than in policy:

1. **It never states a security finding it did not observe.** A fetch that
   failed is `observed: false`, scores zero, and is never rendered as a gap.
2. **Nothing reaches a stranger without a person.** Every outbound message
   stops in an approval queue, and every §2.1 rule is re-checked at the moment
   of sending, not when the campaign was built.

---

## 2. The five invariants — read before changing anything

These are from `PROMPT.md §2`. They are not style preferences; most of them
are load-bearing for legal exposure or for the product's credibility. Every
one has tests behind it.

**§2.1 Outreach compliance.** Cold outreach is **email and LinkedIn only** —
cold voice and cold SMS must be structurally impossible, not merely disabled.
Consent is per channel and its *absence* means NO. Quiet hours are enforced in
the **recipient's** timezone. The `suppressions` table beats everything and is
checked in the send path. AI voice calls disclose they are AI first.

**§2.2 Evidence integrity.** Findings carry the raw evidence that produced
them. Findings older than 14 days are stale and must be re-verified before
appearing in any outbound draft. The scanner reads **public pages only** —
homepage headers, `/.well-known/security.txt`, `/security`, `/trust`, the TLS
cert, homepage script tags. No port scanning, no probing for `.git` or `.env`.
Every piece of user-facing copy calls it posture review from the outside, never
a security test.

**§2.3 Secrets.** No credential in a source file, a log line, or an agent's
context window. Third-party credentials live encrypted at rest in `secrets`.
The agent is never handed a raw key — it calls typed tools and the tool reads
the credential server-side. Driver and validation errors print the *class* of
failure, never the message, because a DSN carries a password.

**§2.4 Irreversible actions need a human.** Implemented with the SDK's
`canUseTool` callback, not UI discipline.

**§5.5 Model seam.** `decideLlmCall` decides whether a task may reach a remote
model. Lead data stays local unless `LLM_ALLOW_REMOTE_LEAD_DATA` is set.

Plus `PROMPT.md §12` ("Do not"): no custom agent loop, no raw SQL tool for the
agent, no Redis/Kafka/vector DB, no `permissionMode: "bypassPermissions"`.

---

## 3. Architecture

**Three processes, five packages, one Postgres.** No microservices.

| process | what it is | can it run serverless? |
|---|---|---|
| `apps/web` | Next.js 16 App Router (Turbopack), the whole UI + API | yes — this is what's on Vercel |
| `apps/agent` | the long-running worker: agent turns, the send tick, IMAP, recovery jobs | **no** |
| `apps/voice` | Twilio ConversationRelay over a WebSocket (Phase 6) | **no** |

| package | holds |
|---|---|
| `packages/core` | pure logic, no I/O — scoring, normalisation, consent, drafting, redaction |
| `packages/db` | Drizzle schema, hand-written reversible migrations, typed queries |
| `packages/scanner` | the public-surface scanner, ported from a Python engine and proved against it |
| `packages/tools` | the `agency` MCP server — the agent's typed tools |
| `packages/llm` | the single-shot model seam (§5.5), shared by agent and voice |

TypeScript strict with `noUncheckedIndexedAccess`; npm workspaces; TS project
references (`npx tsc --build`). Tests run on PGlite (a real Postgres compiled
to WASM), and CI additionally runs them against a real Postgres container.

**The web app must never import `@agency/db`'s package index** — that drags in
the migrator, which resolves files through `import.meta.url` and breaks the
Vercel build. Use the `/schema`, `/queries`, `/schema-version` subpaths.

---

## 4. Data model

27 tables. Migrations `0001`–`0017`, each a reversible `.up`/`.down` pair. The
migrator refuses to run if an already-applied migration has been edited
(sha256 of both files), because silent drift between what ran and what is in
the repo is how a schema stops matching its code.

```
orgs  users  accounts  sessions  verification_tokens     — identity
icp_profiles  companies  scans  findings  scores         — the data core
contacts  consents  suppressions                          — who may be contacted
campaigns  touches                                        — outreach
deals  meetings  proposals                                — the pipeline
chat_sessions  chat_messages  approvals  audit_log        — the agent runtime
agent_defs  connectors  secrets                           — runtime config
calls                                                     — voice
schema_migrations                                         — the ledger
```

Notable: `findings.observed` is the §2.2 boolean. `touches` is the single
outbound record for every channel, and carries `reply_kind` (0017) for triage.
`suppressions` covers email, domain, phone and LinkedIn.

---

## 5. What it can actually do

### The CRM half — works with nothing but Postgres

| | route |
|---|---|
| Dashboard with counts and an honest "what this can and cannot do" panel | `/` |
| Companies list with score, tier and last-scan date | `/companies` |
| Company detail: findings, each with its evidence and timestamp | `/companies/[domain]` |
| CSV / paste import | `/companies/import` |
| Pipeline kanban, deal ownership, stage moves, lost-reason prompt | `/pipeline` |
| Approvals queue — drafts, and parked tool calls | `/approvals` |
| Campaigns — daily cap, quiet hours, auto-send toggle | `/campaigns` |
| Suppressions — add/remove, normalised on the way in | `/suppressions` |
| Meeting brief generated from the latest scan | `/meetings/[id]` |
| Proposal document, with a stale-evidence banner | `/proposals/[id]` |
| Connectors (MCP servers) with test-connection | `/settings/connectors` |
| Subagents as data — instructions, model, tool allowlist | `/settings/agents` |
| Public booking page, consent boxes unticked by default | `/book/[slug]` |
| Health + schema agreement | `/api/health` |

26 API routes alongside these. Auth is Auth.js v5 magic link, `strategy:
'database'`; `proxy.ts` gates everything except `/signin`, `/api/auth`,
`/api/health`, `/api/inbound`, `/book` and `/api/book`.

### The agent half — needs the worker process

Chat at `/chat` streams over SSE from `apps/agent`. The agent gets nine typed
tools from the in-process `agency` MCP server:

```
get_icp  get_company  search_companies  scan_company  score_company
get_pipeline  update_deal  book_meeting  queue_touch
```

`queue_touch` is the draft path — it parks a message on a human rather than
sending. High-risk tools block on the approval queue via `canUseTool`; a
third-party MCP tool nobody has reviewed asks a person **every** time.

Connectors and subagents are read from the database at the start of every
turn, so adding an MCP server in the UI makes its tools usable in the very
next message with no restart.

The worker also runs the send tick, IMAP reply detection, stuck-send recovery,
approval expiry and the sign-in-token sweep.

### Scanning

**There is no scan button anywhere in the UI, by design.** Scanning is either
`npm run scan` from a terminal, or the agent calling `scan_company`. The
companies page says so in prose when companies are unscanned.

---

## 6. Current state — read this before concluding anything is broken

### Live

`https://myagencyos.in` — Vercel, TLS valid to 25 Dec 2026, Neon Postgres,
schema `0017`, production code current. Verify any time, no credential needed:

```bash
curl -s https://myagencyos.in/api/health
```

`schema.state` is `ok | behind | ahead | unknown`. It returns 200 even when it
disagrees — deliberately, because the container healthcheck would otherwise
restart-loop the app. `?strict=1` turns a disagreement into a 503.

### What does not work live, and why

Everything below reduces to **two** facts, not many separate faults:

**(a) No worker is hosted.** `AGENT_URL` is unset. So: chat shows "The agent is
not configured"; no draft can ever be written (only `queue_touch` writes one);
the approvals queue is permanently empty; nothing sends; no reply is read; the
connector probe cannot run. All of these degrade to a clear message rather than
hanging.

**(b) Production has never been scanned.** 16 seeded companies, **zero**
findings. So every row shows "not scanned", "Generate proposal" is disabled
with the reason printed beside it, and meeting briefs carry a warning. This is
one command away from being fixed:

```bash
DATABASE_URL='<pooled Neon URL>' npm run scan
```

**Unresolved:** the sign-in email. The app logs `magic link sent` and the
message does not arrive at the owner's Gmail — checked across inbox, spam and
trash over 7 days. Yet the owner was demonstrably signed in earlier (proved by
comparing Vercel log shapes: authenticated requests invoke the function and
show `λ`, gated ones do not). So delivery worked once and does not now. The
provider behind `SMTP_HOST` is the place to look. Note that a failed send is
**deliberately silent** to the user — see §8 below.

### Local — fully working, including chat

```bash
npm run db:local                                   # PGlite over TCP on 5432
npm run db:migrate && npm run db:seed
AGENT_USE_LOCAL_LOGIN=1 npx tsx --env-file=.env apps/agent/src/index.ts
npm run dev                                        # or next dev apps/web
./tools/dev-login.sh                               # prints a sign-in link
```

`AGENT_USE_LOCAL_LOGIN=1` authenticates the worker as the developer's own
Claude Code login instead of burning API credits, and is **refused outright**
when `NODE_ENV=production`. The worker logs `chat: enabled (local_login)` and
`outreach: send-only|send-and-receive|disabled` at boot — that line is the
authority on what it will actually do.

Worker ports: health on `AGENT_PORT` (3001), API on `AGENT_PORT + 1` (3002).
`AGENT_URL` must point at the **API** port.

---

## 7. Commands

```bash
npx tsc --build                 # build all workspace packages
npm run typecheck               # + apps/web and the test project
npx vitest run --maxWorkers=1   # 1528 tests, ~100s. -1 worker matters: see §8
npm run db:migrate -- status    # what is applied
npm run scan                    # the scanner CLI
./tools/remote-setup.sh         # migrate + seed a remote DB (hidden prompt)
./tools/remote-status.sh        # read-only schema facts, safe to paste
./tools/dev-login.sh            # a local sign-in link without a mailbox
./tools/run-worker.sh           # the worker against production
./tools/mail-dns.sh             # SPF/DKIM/DMARC for a sending domain
./tools/add-teammate.sh         # add a user
./tools/spend.sh                # model spend
```

**Credential handling.** The `remote-*` scripts read connection strings from a
hidden `/dev/tty` prompt into the process environment and nowhere else — no
file, no argument list, no shell history (§2.3). They need a real terminal and
will refuse to run through a pipe or a tool. Do not work around this.

**Deploying.** A local `vercel build` traces `.env` into the deployment output,
which is a credential-exfiltration path. `DEPLOYING.md §4a` has the procedure —
move the env files aside, build, verify the trace contains only `.env.example`,
deploy prebuilt, restore. Prefer git-connected deploys, where it cannot arise.

---

## 8. Gotchas that have already cost time

- **`--maxWorkers=1`.** `apps/voice` went from 945s and two failures to 12.9s
  and fourteen passes at the same commit.
- **Tests share one migrated snapshot.** `migratedDb()` migrates once per
  process and hands each test a copy via `loadDataDir` (290s → 97s).
  `harness.test.ts` exists to prove the isolation still holds.
- **PGlite is a looser gate than production.** It embeds Postgres 18.3 and will
  accept syntax a Postgres 16 target rejects; it also drops `NOTIFY` entirely
  and does not isolate advisory locks. CI's real-Postgres job is the real gate.
- **Homebrew node is broken on the author's Mac.** Put `/usr/local/bin` first.
- **The Agent SDK does not need an API key.** `apiKeySource: 'none'` uses the
  local login. Workspace scoping travels in `ANTHROPIC_CUSTOM_HEADERS`, *not*
  `ANTHROPIC_WORKSPACE_ID` (that is only read on the WIF path). The child env
  must also pass `USER`, or the CLI cannot find the keychain entry and reports
  a rejected key it never sent.
- **A failed sign-in send is silent on purpose.** Throwing out of
  `sendVerificationRequest` produces an error redirect while the non-member
  path returns normally — an exact membership oracle, widest open on a
  deployment whose mail is not configured yet. The failure is logged as
  `magic link could not be sent`, not shown.
- **Never wrap react-router `<Routes>` in `AnimatePresence mode="wait"`** —
  unrelated to this repo, but a recurring trap in the author's other projects.

---

## 9. Deliberately not built

Do not "fix" these:

- **No scan button in the UI** — scanning is a CLI or an agent tool.
- **No signup, billing, marketing site or multi-tenancy** — one seeded org.
- **No skill-upload UI** (`PROMPT.md §6` lists it; `CLAUDE.md` says why).
- **No `draft_outreach` tool by that name** — a draft is `queue_touch` parked
  on a human, which is Phase 4's single send path.
- **Voice/SMS are inbound-only** and Phase 6 stays unused until A2P 10DLC
  clears. Cold dialling code does not exist and must not be added.
- **Calendar invitations are not sent** — a meeting here moves the deal; the
  invite goes from a real calendar.
- **Nothing sources new companies on its own** — import, add by hand, or let
  the agent search a connector and put what it finds through the gate.

Two known gaps that *are* real, and are design questions rather than bugs:
the campaigns auto-send toggle promises messages will go without a person, but
nothing ever enrols a contact into a campaign; and there is no UI to start a
new chat thread or switch between them, though the routes exist and work.

---

## 10. Phase status

Phases 0–5 are built and their Definitions of Done pass. Phase 6 (voice) is
built and proved end to end against a simulated Twilio — only the carrier is
untested, and it must stay that way until A2P registration clears.

The next real work, in order: **host the worker** (`fly.toml` is written and
validated; `docker-compose.yml` defines the whole stack), **set up a sending
domain** (`./tools/mail-dns.sh`), **wire reply receiving**, and **scan
production**. Only the last of those needs no hosting decision.
