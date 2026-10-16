# Agency OS — what this repo is and what it can do

A briefing for a session picking this up cold. Written 2026-09-27; updated
2026-09-30 for the release that brings migration 0018, and 2026-10-01 for SMS
through DoveSoft (migration 0019) and the fixes of four review rounds.

Read this first, then `CLAUDE.md` (about 3,800 lines — decisions, deviations
and the bugs that have already been found the hard way) and `PROMPT.md` (the
build spec). `DEPLOYING.md` is the deployment reference; `GO-LIVE.md` is the live
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
checked in the send path. AI voice calls disclose they are AI first. An SMS
(0019) goes only to a recorded opt-in, only as a DLT-registered template with
its slots filled, never auto-sent, and a STOP texted back suppresses the
number.

**§2.2 Evidence integrity.** Findings carry the raw evidence that produced
them. Findings older than 14 days are stale and must be re-verified before
appearing in any outbound draft — and the send path checks it again at the
moment of sending: a message whose words quote a scan that has aged out since
is refused `stale_evidence`, and nobody may approve past it; the fix is a
re-scan and a new draft. The scanner reads **public pages only** —
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

32 tables, counting the ledger. Migrations `0001`–`0019`, each a reversible
`.up`/`.down` pair. The migrator refuses to run if an already-applied migration
has been edited (sha256 of both files), because silent drift between what ran
and what is in the repo is how a schema stops matching its code.

```
orgs  users  accounts  sessions  verification_tokens     — identity
icp_profiles  companies  scans  findings  scores         — the data core
contacts  consents  suppressions                          — who may be contacted
campaigns  touches                                        — outreach
message_templates                                         — DLT-registered SMS templates (0019)
deals  meetings  proposals  proposal_shares               — the pipeline
notes  tasks                                              — internal work (0018)
chat_sessions  chat_messages  approvals  audit_log        — the agent runtime
agent_defs  connectors  secrets                           — runtime config
calls                                                     — voice
worker_heartbeats                                         — a system table, no org (0018)
schema_migrations                                         — the ledger
```

Notable: `findings.observed` is the §2.2 boolean, and `findings.scored` (0018)
marks the informational signals the ICP does not score — a CHECK keeps them at
weight 0. `touches` is the single outbound record for every channel, and
carries `reply_kind` (0017) for triage, `handled_at`/`handled_by` for the
inbox and `answers_touch_id` for a threaded answer (0018), and
`template_id` plus the operator's delivery report beside `status` (0019) —
an outbound SMS cannot be stored without a template. `suppressions`
covers email, domain, phone and LinkedIn, and records which path wrote each
row in `source`. `contacts.email_bounced_at` marks an address, never a person
(a bounce is not a suppression). `users.revoked_at` is how access ends —
nobody is deleted. `meetings.outcome` is held, no-show or rescheduled.


---

## 5. What it can actually do

### The CRM half — works with nothing but Postgres

| | route |
|---|---|
| Dashboard: the worker line, "needs a look" counters, the last ten audit lines, an honest "what this can and cannot do" panel | `/` |
| Companies list — filter, sort, open-deal filter, a count line, CSV export of the view | `/companies` |
| Company detail: findings with evidence, informational signals, score history, the findings diff, a timeline, notes, tasks, the conversation (with each SMS's delivery report), edit | `/companies/[domain]` |
| Company CSV / paste import | `/companies/import` |
| Contacts: the consent ledger, a send-check per campaign, edit, record download, erasure (owners), Draft SMS from a registered template | `/contacts` |
| Contacts CSV import — never writes a consent row | `/contacts/import` |
| Inbox: every reply, its kind, handled, reclassify, answer (a parked draft) | `/inbox` |
| Tasks: mine / all / overdue, kickoff and renewal templates, LinkedIn steps a person sends | `/tasks` |
| Pipeline kanban, deal owners, stage moves, lost-reason prompt, "untouched for N days", next action and due list | `/pipeline` |
| Pipeline analytics — win rate, velocity, conversion, time in stage, each with its denominator | `/pipeline/analytics` |
| Approvals queue — drafts with the sender's own decision and the evidence they quote, and parked tool calls | `/approvals` |
| Campaigns — daily cap, quiet hours, auto-send toggle, enrolment, the bounce auto-pause note; SMS campaigns, which never auto-send and are never enrolled | `/campaigns` |
| Suppressions — add/remove, normalised on the way in, tagged with the path that recorded each | `/suppressions` |
| Meeting brief from the latest scan; outcome, cancel, reschedule, `.ics` download | `/meetings/[id]` |
| Proposal document with a stale-evidence banner; print, Markdown, share link | `/proposals/[id]`, `/proposals/[id]/print` |
| Compliance — the auditor's questions, counted from rows | `/compliance` |
| Audit log — every action as a sentence, filterable | `/audit` |
| Chat threads — list, switch, rename, archive (sending a turn needs the worker) | `/chat`, `/chat/[sessionId]` |
| Calls (Phase 6, not switched on) | `/calls`, `/calls/[id]` |
| Settings: ICP (read-only), connectors and the catalog, credentials, agents, team, spend, mail DNS, deployment, SMS templates and the DLT CSV import | `/settings/*` |
| Public booking page, consent boxes unticked by default | `/book/[slug]` |
| Public one-click unsubscribe page | `/unsubscribe/[token]` |
| Public buyer proposal page — no score, no tier | `/p/[token]` |
| Health, schema agreement and the worker's heartbeat | `/api/health` |

37 pages and 65 API routes. Auth is Auth.js v5 magic link, `strategy:
'database'`; `proxy.ts` gates everything except `/signin`, `/api/auth`,
`/api/health`, `/api/inbound`, `/book`, `/api/book`, `/api/cron`,
`/api/unsubscribe`, `/unsubscribe`, `/p` and `/api/p`. Inside its handler
each authenticates the request where it acts — the crons by a bearer secret,
the inbound webhooks by a signature or a shared secret, unsubscribe and share
links by a token — and sign-in, health and the booking page are open by
design.

The release on 0018 added 18 of the pages and 33 of the routes. The routes,
with the capability that gates each: contacts — `PATCH /api/contacts/[id]`
gains an `update` action (edit, `contacts:write`), `GET
/api/contacts/[id]/send-check` (`contacts:read`, recipient masked to its
domain), `POST /api/contacts/[id]/consent` (a grant over a refusal is 409; a
lift is owner-only), `GET /api/contacts/[id]/record` (`contacts:read`,
audited first), `POST /api/contacts/[id]/erase` (owners); `PATCH
/api/companies/[id]`; `PATCH /api/inbox/[id]` (`contacts:write`) and `POST
/api/inbox/[id]/reply` (`campaigns:write`, 8 KB); `POST
/api/campaigns/[id]/enrol`; `PATCH /api/deals/[id]/next-action`
(`deals:write`); `PATCH /api/meetings/[id]` (outcome, cancel, reschedule;
`deals:write`) and `GET /api/meetings/[id]/ics` (`deals:read`); `GET
/api/proposals/[id]/markdown`, `POST /api/proposals/[id]/share` (mint, and revoke); notes
and tasks — `POST /api/notes`, `PATCH|DELETE /api/notes/[id]`, `POST
/api/tasks`, `PATCH /api/tasks/[id]`, `POST /api/tasks/templates`; `POST
/api/touches/[id]/performed` (a LinkedIn step); `GET /api/search`; `GET
/api/export/{companies,findings,consents}`; `POST /api/users`, `PATCH
/api/users/[id]` (owners); `PATCH /api/connectors/[id]/credential` and `DELETE
/api/credentials/[id]`; `PATCH /api/chat/sessions/[id]` (rename, archive, restore); `GET
/api/settings/mail-dns`; and the public `GET /api/cron/{rescan,digest}`,
`GET|POST /api/unsubscribe/[token]`, `POST /api/p/[token]/accept` and `POST
/api/inbound/resend`. 0019 added one page, `/settings/templates`, and six
routes: `GET|POST /api/templates`, `PATCH /api/templates/[id]` and `POST
/api/templates/import` (`campaigns:read`/`campaigns:write`), `POST
/api/contacts/[id]/sms` (Draft SMS, `campaigns:write`), and DoveSoft's public
`GET|POST /api/inbound/dovesoft/dlr` and `/sms`, authenticated by
`DOVESOFT_WEBHOOK_SECRET`.

### The agent half — needs the worker process

Chat at `/chat` streams over SSE from `apps/agent`. The agent gets
forty-nine typed tools from the in-process `agency` MCP server:

```
get_icp  get_company  search_companies  scan_company  score_company
get_pipeline  update_deal  book_meeting  queue_touch
check_send  get_consent  get_replies  classify_reply
get_scan_history  get_evidence_changes  get_stale_companies
get_pipeline_metrics  get_company_timeline  get_compliance_summary  search_crm
add_note  create_task  list_tasks
list_contacts  add_company  update_company  import_companies  add_contact
update_contact  pause_contact  resume_contact  add_suppression
list_campaigns  create_campaign  update_campaign  enrol_contacts  list_drafts
generate_proposal  get_proposal  list_meetings  reschedule_meeting
cancel_meeting  record_meeting_outcome  set_deal_owner  complete_task
worker_status  recent_errors  queue_status  rescan_stale
```

Twenty-six are low — reads, and the three scans — and run at once; twenty
write internal state, ask a person first and say nothing was sent; three
are high: `queue_touch` and `enrol_contacts`, the draft paths, which park
messages on a human rather than sending, and `resume_contact`, which lets
campaigns write to somebody again. The last four of the list stand in for a
terminal: the worker's heartbeat and health, its recent warnings, the
outbound queue, and a re-scan of a few stale companies (CLAUDE.md §2, "The
operator's tools"). High-risk tools block on the approval queue via `canUseTool`; a
third-party MCP tool nobody has reviewed asks a person **every** time, and an
owner can turn any connector tool OFF — a deny in both gate rings, never an
allow. A catalog server's send tools start off.

Connectors and subagents are read from the database at the start of every
turn, so adding an MCP server in the UI makes its tools usable in the very
next message with no restart.

The worker also runs the send tick — the SMTP mailbox for email and DoveSoft
for SMS, one provider per channel — IMAP reply detection, stuck-send recovery,
approval expiry, the sign-in-token sweep, the bounce auto-pause, and a
heartbeat row every tick.

### Scanning

**There is no scan button anywhere in the UI, by design.** Scanning is
`npm run scan` from a terminal, the agent calling `scan_company`, or — once
`CRON_SECRET` is set on Vercel — the nightly rescan, which nobody clicks: up
to six companies per org, never-scanned first, then the stalest. The companies
page says so in prose when companies are unscanned. Thirteen informational
signals are read from the same homepage response — posture context, stored at
weight 0 and never part of the score. No new request class.

---

## 6. Current state — read this before concluding anything is broken

### Live

`https://myagencyos.in` — Vercel, TLS valid to 25 Dec 2026, Neon Postgres,
schema `0017` when this was written, and the repo ahead of it: the code
expects **0019**, and needs **0018 and then 0019 applied before it deploys**
(GO-LIVE.md Part 2b, DEPLOYING.md "migrate FIRST"). Verify any time, no
credential needed:

```bash
curl -s https://myagencyos.in/api/health
```

`schema.state` is `ok | behind | ahead | unknown`. It returns 200 even when it
disagrees — deliberately, because the container healthcheck would otherwise
restart-loop the app. `?strict=1` turns a disagreement into a 503. `worker`
reports the newest heartbeat — `live`, `silent`, `never`, `not_configured`
or `retired` (no worker configured and a row over a week old), its age
in seconds, its mailbox mode (`outreach`) and whether it texts through
DoveSoft (`sms`: `on`, `off`, or null for a worker from before 0019) — and
never changes the status code.

### What does not work live, and why

Everything below reduces to **two** facts, not many separate faults:

**(a) No worker is hosted.** `AGENT_URL` is unset. So: chat says no worker is
connected; no agent draft is written; no EMAIL or SMS sends; IMAP reads nothing; the
connector probe cannot run. All of these degrade to a clear message rather than
hanging. After this release, less depends on it: enrolment writes drafts from
the web (they wait for a worker to send email), LinkedIn steps are sent by a
person from `/tasks`, replies can arrive through Resend's signed webhook,
DoveSoft's delivery reports and texts back arrive at two web routes, and the
rescan and digest are Vercel crons.

**(b) Production has never been scanned.** 16 seeded companies, **zero**
findings. So every row shows "not scanned", "Generate proposal" is disabled
with the reason printed beside it, and meeting briefs carry a warning. Once
`CRON_SECRET` is set the nightly rescan scans them six a night; or it is one
command away from being fixed now:

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

### What runs unattended

Nothing else runs on its own — there is no scan button and no scheduler under
compose.

| where | what | when |
|---|---|---|
| Vercel, with `CRON_SECRET` | the rescan: never-scanned first, then the stalest, `RESCAN_BATCH_SIZE` per org. Each org is claimed first, so an overlapping delivery skips it rather than scanning the same companies twice | 03:17 UTC daily |
| Vercel, with `CRON_SECRET` | the digest to Slack (recorded in `/audit` even with no Slack), a notice for each campaign that paused itself since the previous run's recorded mark (at most three; the digest counts the rest), and the worker-silent alert (not for a retired row: no worker configured, none heard from in a week) | 06:43 UTC daily |
| the worker | the bounce auto-pause, then the send tick; the heartbeat and its 30-day prune | every `OUTREACH_TICK_MS` (15 s) |
| the worker | IMAP reply detection; a message it could not record stays unseen and is retried, five times at most | IDLE, as mail arrives; every 10 minutes regardless; a retry from 60 s, doubling |
| the worker | the restart reconciler (which also prunes expired sign-in links) and stuck-send recovery | at boot |
| the worker | approval expiry | every `APPROVAL_SWEEP_MS` (60 s) |
| `/tasks`, when read | one LinkedIn step per approved LinkedIn message; a claim left `sending` past 30 minutes is failed; a handed step is re-checked, and its words withheld when the send path now refuses it past approval, the contact is paused, or the hand-over is over 24 hours old | whenever somebody opens it |

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
authority on what it will actually do with the mailbox, and `sms: dovesoft
on|off` beside it on texts.

Worker ports: health on `AGENT_PORT` (3001), API on `AGENT_PORT + 1` (3002).
`AGENT_URL` must point at the **API** port.

---

## 7. Commands

```bash
npx tsc --build                 # build all workspace packages
npm run typecheck               # + apps/web and the test project
npx vitest run --maxWorkers=1   # 5243 tests in 190 files (1,590 s single-worker at db09f4d). One worker matters: see §8
npm run db:migrate -- status    # what is applied
npm run scan                    # the scanner CLI
./tools/remote-setup.sh         # migrate + seed a remote DB (hidden prompt)
./tools/remote-status.sh        # read-only schema facts, safe to paste — the migration list shows 0019, then "0018 is applied" and "0019 is applied"
./tools/dev-login.sh            # a local sign-in link without a mailbox
./tools/run-worker.sh           # the worker against production
./tools/mail-dns.sh             # SPF/DKIM/DMARC for a sending domain
./tools/add-teammate.sh         # add a user
./tools/spend.sh                # model spend
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/rescan   # a cron, by hand
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
- **`cp .env.example .env` now boots all three processes.** A blank `NAME=`
  is unset in the web app, the worker and the voice service alike, so the
  lines the example once commented out are live again, and
  `apps/agent/test/env-example.test.ts` boots the worker and the voice service
  on the file. Compose now names every optional variable the web app, the
  worker and the voice service read (`apps/agent/test/compose-env.test.ts`), bar a few listed with
  a reason — before, an optional feature set in `.env` could stay off under
  compose, because a variable the compose file does not name never reaches a
  container.
- **Postgres 18 reports an `ON DELETE RESTRICT` refusal as 23001, not 23503.**
  Neon runs 18.6. Code that turns a refused DELETE of a referenced row into a
  sentence calls `isReferencedRowRefusal` in `packages/db/src/pg-errors.ts`,
  which accepts both (`credentials.ts` does); a source pin keeps the literal
  codes out of every other module.
- **`next build` fails in a worktree whose `node_modules` is symlinked** —
  Turbopack refuses files outside the workspace root. `cd apps/web && npx next
  build --webpack` is the equivalent check there.
- **Never wrap react-router `<Routes>` in `AnimatePresence mode="wait"`** —
  unrelated to this repo, but a recurring trap in the author's other projects.

---

## 9. Deliberately not built

Do not "fix" these:

- **No scan button in the UI** — scanning is a CLI, an agent tool, or the
  nightly cron, which nobody clicks.
- **No signup, billing, marketing site or multi-tenancy** — one seeded org.
- **No skill-upload UI** (`PROMPT.md §6` lists it; `CLAUDE.md` says why).
- **No `draft_outreach` tool by that name** — a draft is `queue_touch` parked
  on a human, which is Phase 4's single send path.
- **Voice is inbound-only** and Phase 6 stays unused until A2P 10DLC
  clears. Cold dialling code does not exist and must not be added. **SMS is
  opt-in only** (0019): each text is drafted for one person from a
  registered template and approved by a person; nothing texts anybody cold,
  and no SMS campaign auto-sends or enrols.
- **Calls and WhatsApp through DoveSoft are not built** — DoveSoft publishes
  no API for either, and a guessed field name in a path that dials a person
  or reads an opt-out is the one thing the design refuses.
- **Calendar invitations are not sent** — a meeting here moves the deal; the
  invite goes from a real calendar (an `.ics` download is not an invitation).
- **A proposal is not sent from here** — print it, download it, or mint a
  share link for a person to paste into a message they write (a share link is
  not a send).
- **Nothing sources new companies on its own** — import, add by hand, or let
  the agent search a connector and put what it finds through the gate.

The two known gaps this section used to list are closed: enrolment writes one
opener per enrollable contact into a campaign (the first production caller of
`draftOpener`), and `/chat` lists, switches, starts, renames and archives
threads. Still not built, and stated: multi-step sequences, an OAuth connect
flow for the seven connectors that need one, retries or a per-org webhook for
Slack, and any automation of LinkedIn — the provider is a person, by design.

---

## 10. Phase status

Phases 0–5 are built and their Definitions of Done pass. Phase 6 (voice) is
built and proved end to end against a simulated Twilio — only the carrier is
untested, and it must stay that way until A2P registration clears. One further
release, on migration 0018, added the operating layer described in §5; then
SMS through DoveSoft, on migration 0019 — DLT-registered templates, Draft SMS,
a worker provider, two webhooks — built and tested against a recorded fetch
and PGlite, never against DoveSoft itself. Four review rounds have been
fixed on top; `CLAUDE.md` states each fix where its rule lives.

The next real work, in order: **ship that release** — apply 0018 and then
0019, then deploy (GO-LIVE.md Part 2b) — then **host the worker** (`fly.toml` is written and
validated; `docker-compose.yml` defines the whole stack), **set up a sending
domain** (`./tools/mail-dns.sh`), **wire reply receiving** (IMAP for the
worker, or Resend's webhook with no worker at all), and **scan production**,
which `CRON_SECRET` now does on a schedule. SMS waits on DLT registration and
on DoveSoft confirming the three formats its public documentation leaves out
(GO-LIVE.md Part 5b).
