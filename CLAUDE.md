# Agency OS — architecture, invariants, commands

Internal operating system for a small application-security agency. Read
[PROMPT.md](PROMPT.md) for the full build spec; this file is the working
summary a session should read first.

**Current state: Phases 0–6 are built, and every Definition of Done except Phase 2's and Phase 3's is proved** — see the table below for exactly what "proved" means for each. Phase 6 is built but deliberately NOT switched on: §12 says not to before A2P 10DLC registration clears, so the compose service sits behind a `voice` profile and `docker compose up` does not start it.

**The worker deploys to Fly.io** (`fly.toml` at the repo root), and its
defaults are the dangerous part: Fly scales a machine to zero between
requests, which is Vercel's problem wearing a different hat — the advisory
lock drops, the fifteen-second tick stops, and nothing looks broken because
`/readyz` answers fine on a machine that was just woken. `auto_stop_machines`
off and a floor of one machine are load-bearing. Only `DATABASE_URL` (direct,
unpooled) and `AGENT_INTERNAL_TOKEN` are required; **`ANTHROPIC_API_KEY` is
optional and the worker is worth deploying without one** — sending, reply
detection, stuck-send recovery, the restart reconciler and the sign-in-token
sweep all run with no model, and only chat reports `chat_disabled`.

**The web half is LIVE on Vercel** at `agency-os-tau-murex.vercel.app`, against
a Neon Postgres (18.6) with Resend for magic links, migrated through **0016**
and seeded. Proved live: `/api/health` reports `database: ok`, `/signin`
renders, `/book/agency` serves the public booking page (it 404'd until the
seed claimed the slug), and a sign-in request logged `magic link sent`. See [DEPLOYING.md](DEPLOYING.md) — including the two things
a LOCAL `vercel build` gets wrong (it traces `.env` into the upload; deploying
from `apps/web` cannot resolve the hoisted `node_modules`). The agent worker is
NOT deployed and cannot be on serverless, so chat, sending and reply detection
are absent there and every screen that would promise them says so instead.

**Phases 2 and 3's Definitions of Done now PASS.** They were blocked for the
whole build on "the Anthropic account has no credit", and the diagnosis was
wrong: the Agent SDK never needed an API key. Its own types say so —
`apiKeySource: 'none'` is documented as *"no API key in use - e.g. claude.ai
OAuth login"* and `apiProvider: 'firstParty'` as the case where *"Anthropic
OAuth login"* applies. A machine logged into Claude Code can run real turns.
What stood in the way was this repo's own gate asking *"is ANTHROPIC_API_KEY
set?"* when it meant *"can I reach a model?"* — see `AGENT_USE_LOCAL_LOGIN`
below. **Phase 4's is proved against a local SMTP sink, not a real mailbox.**

| | proved | not proved |
|---|---|---|
| Phase 2 | **the whole thing, live.** `npm run smoke:agent` PASSED on 2026-09-25: one turn, 22 tool calls, 284 events, a cost reported, and an evidence-backed ranking of the pipeline's top three built from `scan_company`/`score_company`/`get_company` against the real database | nothing outstanding |
| Phase 3 | **PASSED.** The agent named `mcp__deepwiki__ask_wiki_question`, `read_wiki_contents` and `read_wiki_structure` alongside its own nine, on a worker that had been running since BEFORE the connector row was written — §6's "no restart" promise, in the sequence that actually tests it | the agent *calling* a connector's tool in anger (it enumerates them; the gate asks it to enumerate) |
| Phase 4 | draft → approved in the UI → deferred for quiet hours (live, 21:50 London) → sent in a real SMTP transaction → deal `contacted` → a reply by Message-ID pauses, ties, moves the deal to `replied` → "unsubscribe" suppresses. One test per §2.1 rule. | deliverability through a real mailbox; IMAP IDLE against a live server; a provider webhook with a real secret |
| Phase 5 | live, in the browser: a `replied` deal dragged to `meeting` (HTML5 drop → `deal.moved` audit row) → meeting recorded from the company page at 15:00 London, stored as 14:00Z → brief generated from the rows → proposal generated from the scan (8 scope items with evidence, 2 workstreams, USD 9,600–15,600 at a 1,200 day rate) → `sent` → `accepted` closes the deal `won`. A stranger on `/book/agency` became a company, a contact with E.164 phone, three consent rows carrying the form's wording, a meeting, and a deal at `meeting`. | the agent's `book_meeting`/`update_deal` in a live turn (same blocker as Phase 2); a calendar invitation (deliberately not sent from here) |
| Phase 6 | the whole Definition of Done, end to end against the real service: a SIGNED webhook is answered with `<ConversationRelay>` carrying the disclosure, the relay socket opens against the URL that TwiML handed out, four scripted questions qualify the caller, asking for a person produces the `end` frame whose `HandoffData` makes `/twiml/action` return a `<Dial>`, and the row ends with `answered_at`, `disclosed_ai_at`, an outcome, Twilio's duration and recording URL, a transcript containing the caller's own words, and a summary. `apps/voice/test/service.test.ts`. | Twilio itself — the carrier, the STT and the TTS. A2P 10DLC has not cleared and there are no Twilio credentials, so no real telephone call has been placed to this service |

`npm run smoke:agent` gates Phase 2; `npm run smoke:agent -- --connector <name>`
gates Phase 3.

**The Phase 3 gate could never pass, and that is why it had never been seen
to.** `--connector` asks the agent to LIST its tool names and nothing else, and
the check list then required `toolCalls.length > 0` unconditionally — so an
agent doing exactly what it was told made no tool calls and failed "used the
agency tools" every single time. A gate that cannot report success is the same
defect as a query that cannot report failure (cf. the disclosure audit in §
Voice): it reads as evidence and is not. The check is now pushed only for the
prompts that ask the agent to go and read the CRM.

---

## 1. The invariants (PROMPT.md §2)

These are not preferences. Violating them creates legal exposure or destroys
the product's value. Where a rule can be expressed in the schema it *is*
expressed in the schema, so that a bug in application code cannot produce a bad
row. `packages/db/test/invariants.test.ts` asserts the database rejects each
one.

### Outreach compliance (§2.1)
- **Cold outreach is email and LinkedIn only.** Voice and SMS are for inbound
  contacts and contacts with a recorded opt-in.
  *Enforced now:* `campaigns_no_auto_send_on_voice_or_sms` — a campaign cannot
  have `auto_send = true` on a `voice` or `sms` channel.
- **Consent is per channel and absence means NO.** `consents` has
  `UNIQUE (contact_id, channel)`, `granted` and `source` are both NOT NULL,
  `consents_source_is_not_blank` rejects an empty or whitespace-only source
  (NOT NULL alone accepts `''`), and no row is ever created by default. There
  is no "unknown" state to misread. Deleting a contact removes their consent
  rows, so a re-imported contact correctly starts from NO.
- **Suppression wins over everything.** `UNIQUE (org_id, kind, value)`, checked
  in the send path — never in the campaign builder. The send path does one
  indexed equality lookup, so `suppressions_value_is_normalised` makes the
  normalised shape a constraint rather than a convention: email and domain must
  be lower-cased and trimmed, phone must be E.164. An unnormalised value cannot
  be stored, so `Stop@Example.com` can never coexist with `stop@example.com` as
  a second, unsuppressed row. `packages/core` gains the matching `normalise()`
  helper in Phase 4; until then the database is what enforces it.
  **Phase 4 obligation:** a suppression insert that fails is an opt-out that was
  never recorded — worse than the bug this constraint replaced. When
  `normalise()` cannot parse an inbound number or address, the send path must
  fail loudly and route it to a human, and must never fall through to sending.
  Every geo the seeded ICP targets is covered by a test in
  `packages/db/test/invariants.test.ts`.
- Quiet hours are stored as wall-clock times and must be evaluated in the
  **recipient's** timezone. *The evaluation lands in Phase 4.*

### Evidence integrity (§2.2)
**The app must never state a finding it did not observe.** Four separate
guards, because one of them alone was not enough:

1. `findings_unobserved_has_no_gap` —
   `(observed AND gap IS NOT NULL) OR (NOT observed AND gap IS NULL)`.
   Makes the two columns agree. On its own this only stops a row from
   contradicting *itself*.
2. `findings_observed_requires_a_successful_scan` (trigger, INSERT **and**
   UPDATE) — a finding may not claim `observed = true` if the scan it hangs off
   has `ok = false`. This is the guard that actually stops the §2.2 scenario:
   a timeout or WAF block becoming "they are missing X". Firing on UPDATE
   matters — otherwise an honest row can be edited into a dishonest one.
3. `findings_a_claimed_gap_carries_evidence` — `gap = true` requires a
   non-empty `evidence` object. §2.2: "Findings carry the raw evidence that
   produced them." A gap with `'{}'` is an unsupported claim.
4. `findings_scan_matches_company_and_org` (composite FK on
   `(scan_id, company_id, org_id)`) — the denormalised `company_id` is what the
   UI reads, so it must agree with the scan. Without it a batch scanner with an
   off-by-one can file one company's evidence under another's name and every
   constraint still passes.

**`findings.stale` is a cache, not the answer.** `markStaleFindings` writes it
and `npm run scan` calls that on every run, so the column is current as of the
last scan and no more. A finding that aged past the threshold an hour ago still
has `stale = false` on it, and there is still no scheduled rescan.

So **freshness is DERIVED from the scan's `ran_at`**, by `isStale()` in
`packages/core/src/freshness.ts`, everywhere it decides whether something may
be shown or quoted: `quotableFindings`, the company detail page, and
`npm run scan -- --stale`. Reading the column instead is how a three-week-old
gap rendered with no mark on it, and how `--stale` — which filtered on
`lastScanAt === null`, a copy of the never-scanned filter — could never pick a
single company it existed to re-verify. The column is still narrowed on first
where it is indexed and cheap, but never on its own, and Phase 4's draft
generator must do the same.

Two more §2.2 links, both added in 0006 and after:
- **A score names the scan it was computed from.** It used to record a company
  and a time, so "the latest score" and "the latest scan" were independent
  lookups; a page could show one scan's number above another scan's evidence —
  a qualification nobody computed. `scores.scan_id` carries the same composite
  FK `findings` uses, so the denormalised `company_id` and `org_id` must agree
  with the scan's.
- **`recordScan` computes the score itself**, from the ICP row it stamps.
  Taking an id and a pre-computed `ScoreResult` separately let a caller score
  against one profile and stamp another's id. It also reads each gap's weight
  from the ICP rather than from `result.gaps` — that list is EMPTY for a
  disqualified company, so every real gap such a company had was written at
  weight 0.
- The scanner reads **public pages only**. No port scanning, no probing for
  `.git`, `.env`, admin panels or backups. Every piece of copy in the app must
  describe it as posture review from the outside, not a security test.

### Secrets (§2.3)
- No credential in a source file, a log line, or an agent's context window.
- `connectors.secret_ref` points at an encrypted credential; it never holds one.
- The CLIs strip credentials from their output — `safeTarget()` in
  `packages/db/src/cli.ts` prints `host:port/db` and never the DSN.
- `redact()` in `packages/core` walks nested objects and arrays and blanks any
  value whose **key** looks sensitive; both loggers use it. It is a backstop,
  not the primary defence — it matches on key name only, so a credential under
  an innocuous key (`{ value: 'sk-live-…' }`) still gets through. Do not read
  it as permission to log arbitrary objects. `packages/core/test/redact.test.ts`
  pins that limitation as an explicit test.
- `sendVerificationRequest` deliberately does **not** log the magic-link URL.
  That URL is a bearer credential.

### Irreversible actions need a human (§2.4)
- Anything leaving the building goes through the `approvals` queue unless a
  campaign has `auto_send = true`.
  *Enforced now:* `approvals_decided_has_decider` — a row cannot claim it was
  approved without naming who decided and when.
- *Built in Phase 2.* `decideApproval` owns the expiry rule the schema left
  open: 0004 deliberately does **not** forbid `status = 'approved'` with
  `decided_at > expires_at`, so a stale-tab approval surfaces as a clean
  "expired" from the decision path rather than a constraint violation and a
  500. The same single statement arbitrates two people clicking Approve at
  once, and hands the loser the WINNER's row so their screen can say who
  decided instead of showing an error.
- **Never set `permissionMode: "bypassPermissions"`.** See §8 below — there are
  three ways the gate is skipped, and the spec recommends two of them.

---

## 2. Layout

```
apps/
  web/          Next.js 16 App Router — UI + BFF routes + Auth.js
  agent/        the long-running worker (Phase 2 gives it the query() loop)
packages/
  core/         domain logic. NO I/O, no framework, no database.
  db/           schema, reversible SQL migrations, typed queries, seed
```

`packages/core` has an **empty `dependencies` block on purpose**, and
`packages/core/test/no-io.test.ts` reads the source to prove it imports no
framework, no driver, no Node I/O built-in, and never touches `process.env`.
This is the one architectural rule worth being pedantic about (§3).

```
packages/scanner   the public-surface signal collector (Phase 1)
packages/tools     the agency's own MCP tools, as plain data (Phase 2)
packages/llm       the single-shot model clients (§5.5) — the only I/O half
```

### The runtime is assembled from the database, every turn (Phase 3)

`apps/agent/src/runtime/connectors.ts` turns `connectors` rows into the SDK's
`mcpServers`, and `runtime/agents.ts` turns `agent_defs` rows into `agents`.
Both are read **fresh on every turn and never cached**: §6's promise is that a
server added in the UI is usable in the very next message, and a cache with any
TTL at all breaks that in a way nobody can debug from the outside.

A row that cannot be built is SKIPPED with a reason and logged, never thrown
on — one broken connector must not take the whole chat down.

**`AgentDefinition` carries its own `permissionMode`.** §7's snippet maps four
fields, which is right, but a spread of the row — or a later innocent-looking
`...extra` — would make "add a subagent" a way to set `bypassPermissions` from
a web form. `ALLOWED_AGENT_KEYS` is frozen, asserted key by key, and a source
test bans spreading the row outright (the same instrument that keeps
`return null` out of `can-use-tool.ts`).

**Three things a connector must not reach**, each with a test in
`apps/agent/test/connectors.test.ts`:

- **the worker's own environment.** A `stdio` connector is a process an owner
  chose through a web form; inheriting `process.env` would hand it
  `ANTHROPIC_API_KEY`, `DATABASE_URL` and `SECRETS_KEY`. Its env is built from
  scratch, and its credential goes in `MCP_SECRET` rather than on a command
  line, which is visible in `ps` to anyone on the host.
- **the network the worker runs in.** `isReachableConnectorUrl` refuses the
  same hosts the scanner does, for a worse reason: the worker would send the
  connector's CREDENTIAL to whatever answered `169.254.169.254`. Re-checked at
  BUILD time, not only when the row was written.
- **the log.** Names and transports only. A URL carries a token in a query
  string sooner or later, whatever the form says.

### Skills, and the one bypass that is genuinely unavoidable (§6)

§6 says to mount a skills volume and set `settingSources: ["project"]`,
`skills: "all"`, and `"Skill"` in `allowedTools`. Two of those three are
refused and the third is real:

- **`"Skill"` in `allowedTools` — refused, and the SDK agrees.** A bare entry
  auto-approves before `canUseTool` is consulted, and it is also unnecessary:
  the SDK says of the `skills` option, verbatim, *"This is the single place to
  turn skills on; you do not need to add `'Skill'` to `allowedTools` yourself
  when using this option."* The recommendation costs a bypass and buys nothing.
- **`settingSources: ["project"]` — required. Measured, not assumed.** Against
  a scratch directory holding one `SKILL.md`:

  | settingSources | commands | the skill discovered |
  |---|---|---|
  | `[]` | 49 | no |
  | `['project']` | 50 | yes |

  And the SDK warns that *"Allow rules from settings files can also shadow the
  callback but are not visible here"* — the third documented bypass.

**What makes that acceptable: the bypass is in the FILES, not in the skills.**
A skill is markdown, and everything it makes the model *do* still arrives at
`canUseTool`. So `inspectSkillsRoot` refuses to turn skills on at all if the
volume contains anything that could carry a permission rule, an agent, a
command or a hook — checked at boot, naming the file that stopped it, and
never fatal (the agent works fine without skills). Off entirely unless
`AGENT_SKILLS_DIR` is set, so a deployment that does not use skills does not
carry the setting source.

The compose mount is **read-only**: a skill is instructions the agent follows
on every later turn, so a writable mount is a prompt-injection surface with no
expiry and no audit trail. `packages/db/test/deployment.test.ts` asserts it.

**No upload UI.** §6 asks for one; it is the one §6 item not built. An endpoint
that writes files into the directory the agent reads as instructions is the
single highest-value target in the product, and it is not needed to use the
feature — a skill is a file on a volume, put there the way the volume is
administered. Flagged here rather than hidden (§13).

**Test connection polls past `pending`.** MCP startup is non-blocking in this
SDK: `mcpServerStatus()` answers immediately and a perfectly healthy server
reports `pending` for the first second or two. Taking that first answer made
Test connection report "could not be reached" for *every working server* —
the worst possible failure for a button whose whole job is to say whether a
server works. (`alwaysLoad: true` would make startup blocking instead, but it
is capped at a 5s connect timeout and changes how the server's tools load into
a real turn; a probe should not need a different config from the thing it
tests.)

Not yet created, because their phase has not arrived (§12 — do not scaffold all
seven phases at once): `apps/voice` (Phase 6, and only after A2P 10DLC
registration clears).

### packages/tools
The tools as PLAIN DATA, with **no import of the Agent SDK anywhere in the
package**. `apps/agent/src/mcp/agency.ts` is the only file that adapts them to
`createSdkMcpServer`, and it is about thirty lines.

That split is not style. The SDK ships no mock transport and no
recorded-session mode, so anything needing the SDK to be *defined* is also
untestable — and a package that CANNOT import the SDK cannot drag it into the
Next module graph, which CI builds with no secrets on purpose.

Nine tools ship: `get_icp`, `search_companies`, `get_company`, `scan_company`,
`score_company`, `get_pipeline` (low risk), `update_deal`, `book_meeting`
(medium — they write internal state, never anything outbound) and
`queue_touch` (high). `get_pipeline` and `update_deal` arrived with Phase 5,
once `deals` was a table something writes — before that a tool that reliably
returned `[]` would have taught the model a false shape of the business.
`draft_outreach` is the one §6 tool that does not exist by that name: a draft
is `queue_touch` parked on a human, which is Phase 4's single send path.

### packages/scanner
`fetch.ts` does the I/O; `extract.ts` is pure. That split is not cosmetic — it
is what lets the same recorded bytes be replayed through this engine and the
original Python one, which is how the port is proved correct. The list of paths
the scanner may request is a frozen constant in `types.ts`, not a parameter, so
no caller can widen it into something that probes for `.git` or an admin panel.

`capture()` also refuses any host that is not a public DNS name. Python's
`_norm` stops after stripping the path, which leaves userinfo attached — so a
`companies.domain` of `evil.com@internal.corp` produces the URL
`https://evil.com@internal.corp/`, requesting *internal.corp* while the row
still reads like evil.com. IP literals, `localhost`, and the reserved and
internal-use suffixes are refused too, `169.254.169.254` among them. The CSV
importer already validates domains, but this check lives in the one place that
turns a stored string into an outbound request, because Phase 2 gives an agent
tools that write to that table. It does not resolve DNS, so a public name
pointing at a private address is still out of scope; that needs a connect-time
check and should be added if the scanner is ever aimed at untrusted input.

### What lands in `packages/core`, and when
| Phase | Domain rules |
|---|---|
| 0 ✅ | authorisation — `can(principal, capability)`, log redaction — `redact()` |
| 1 ✅ | the ICP definition, scoring, tiering, disqualifiers, the `observed` rule |
| 2 ✅ | risk classification (§5.4), the chat wire types, the freshness rule |
| 3 ✅ | nothing new — §6 and §7 are assembly, and assembly needs the database |
| 4 ✅ | consent, suppression, quiet hours, daily caps — the one send path |
| 5 ✅ | `proposalFromFindings` and `meetingBrief` — the two documents the pipeline writes, pure, refusing stale evidence |
| 6 ✅ | the AI disclosure, the opt-out/handoff/sentiment readers, the scripted turn, and §5.5's `decideLlmCall` |

---

### The send path (Phase 4, §8.4)

**One function decides; one function sends; nothing else may.** `decideSend`
in `packages/core` is pure — facts in, decision out — and it is the ONLY
place §2.1's rules live. A caller cannot reorder the checks because it does
not perform them, and cannot skip one because the facts for all of them are
required arguments: a caller that forgot the suppression lookup cannot call
the function at all. `dispatchTouch` in `packages/db` is the only function
that reaches a provider, and both an auto-send message and a human-approved
draft go through it. The order is §8.4's, and `packages/core/test/send.test.ts`
asserts the ORDER, not just the outcomes — the refusal code is what somebody
reads six months later.

**A person approves the words, not the moment.** Approving a draft names the
recipient, the campaign and the approver (0011: a row may not say "approved"
without both, like `approvals`) and marks it `approved`. The worker's tick
then runs it through every rule AT THE MOMENT OF SENDING, because the
recipient may have opted out in the hour since. `approvedByHuman` satisfies
the approval gate exactly as `autoSend` does and nothing else.

**Absence is never permission.** `consent: null` is a refusal, distinct from
`{granted:false}` because "nobody asked" and "they said no" are different
facts and only one must never be re-asked. `recipientTimeZone: null` is a
refusal — not knowing when it is where somebody lives is a reason to wait,
and the shortcut (the sender's zone) is the mistake §2.1 names. An address
that cannot be normalised is a refusal, because no suppression row could
ever have matched it: `suppressed: false` there means unknown, not clear.

**Three refusals nobody can approve past.** A suppression (somebody asking
to be left alone), a recorded refusal, and cold voice/SMS/WhatsApp. §2.1
says cold SMS must be "structurally impossible"; an approver offered enough
impossible things learns to click yes.

**The clock is not a refusal.** Quiet hours and the cap DEFER a message
(`scheduled_for`, same status, approver kept); everything else is terminal.
The default window wraps midnight, and the naive comparison is not merely
wrong for 21:00–08:00, it is inverted.

**Every outbound message carries a campaign**, because the campaign is where
the cap and the quiet hours live. Companies and contacts carry an IANA
`time_zone` (0010) — never derived from `companies.country`, which is not a
timezone (the US has six).

**A reply does four things in one call** (`recordInboundReply`): logs the
inbound touch, pauses the contact (one UPDATE, every campaign, immediately),
cancels what was queued for them, and moves the deal FORWARD to `replied` —
forward only, so a late reply never knocks a booked meeting back. If it
says stop in so many words, the address goes on the suppression list: the
reply IS the opt-out. Inbound mail is matched by the Message-ID this system
sent (unambiguous), then by an address that belongs to exactly ONE contact
across every org — two orgs with the same address on file is a reply nobody
can place, and it is dropped and logged rather than filed under the wrong
agency.

**`sending` is the worker's claim** on a row (0011), so two workers picking
one row produce one UPDATE that matches. A worker that died mid-send leaves
a row that says so, and `recoverStuckSends` marks it `failed` with a reason
— the safe direction; the alternative is guessing the provider was not
reached and sending it twice.

**The mail transport stays out of the Next graph.** `@agency/db/queries`
does not export `smtp.ts`: the web app queues, the worker sends, and a
transport that can deliver has no business in a bundle CI builds with no
secrets. The inbound webhook (`/api/inbound/email`) is exempt from the
cookie gate — a provider cannot carry a session — and refuses everything
when `INBOUND_WEBHOOK_SECRET` is unset.

**LinkedIn is suppressible (0016).** It was not, and that was the worst place
for the gap to be: LinkedIn is one of the TWO cold channels §2.1 permits, so
it was the one channel where somebody could ask to be left alone and the
product had nowhere to record it. `suppressionKeysFor` returned an empty list
— "nothing to check" — which was honest about the schema and wrong about the
product. The stored value is the namespace and the slug, `in/jane-doe` or
`company/acme`, folded and with no scheme, host, query or trailing slash; the
CHECK is that exact shape, so a value that did not come through
`normaliseLinkedIn()` cannot be stored. The namespace is kept because
`in/acme` and `company/acme` are different pages, and a BARE handle is refused
rather than assigned to one of them — guessing stores a key that silently
never matches the person who asked, which is worse than a refusal the operator
can see and fix.

**The slug is canonicalised through percent-encoding and validated WHOLE**, and
the first version was not. It matched with an unanchored character class and
returned whatever prefix matched, so `linkedin.com/in/josé-garcía` became
`in/jos` — the same failure the paragraph above says the design refuses to
make, twice over: that key matches nobody, so the opt-out is recorded against
nothing, and if some other real profile IS `in/jos` it suppresses the wrong
person while the one who asked keeps being contacted. It also gave one person
two keys, because the address bar's percent-encoded spelling and the rendered
unicode normalised differently. Now the value is decoded, folded, re-encoded
and then checked against the stored class in full; anything still outside it is
refused rather than trimmed away, so `normaliseLinkedIn()` and the SQL CHECK
accept exactly the same set. Found by probing inputs no test covered — the
tests written alongside the feature all used ASCII slugs. 0016's down DELETEs LinkedIn rows, because the narrower CHECK
cannot be added while they exist; that cost is stated in the file.

One consequence worth knowing: a LinkedIn touch whose contact has no
`linkedin_url` is now refused as `unparseable_recipient` instead of passing
the suppression step and being stopped later by the provider. That is the
right direction — it is a refusal a human can act on — but it is a behaviour
change, not just a new column.

**Not built:** SendGrid behind the provider interface (the interface is the
point; the second implementation is a few lines when it is needed) and a
LinkedIn *provider* — nothing can send on that channel, so the suppression
above is a rule waiting for its sender rather than one in use.

### The pipeline (Phase 5, §8.6)

**The board moves cards; the rules do not live on the board.** A drop is one
`PATCH /api/deals/:id` through `setDealStage` — the one caller allowed to move
a deal in either direction, because a person said so — and every move writes
an audit row with the stage it left and the stage it reached; the pipeline's
history is the audit log, not a column. Everything automatic goes through
`advanceDeal`, which only moves FORWARD, so a late reply never knocks a booked
meeting back. `deals_one_open_per_company` (0012) makes two automatic callers
that both found no deal produce one deal, and the loser re-reads. A drop on
`lost` asks for the reason first: the route refuses without one, and it is the
only thing anyone learns from a lost deal. The card also carries a "Move to"
control that does the same PATCH, so the board works from a keyboard and can
be driven by a test; the drag handlers were proved with synthetic `DragEvent`s
in the live browser.

**A proposal is derived, never written.** `proposalFromFindings` in
`packages/core` turns the latest scan into scope: one item per gap the
scanner OBSERVED, grouped into workstreams, with the finding's raw evidence
attached so the buyer can check the scope against their own site. §2.2 governs
it harder than any other rule: a signal the scanner could not observe is
listed as *not assessed*, never as fine; a stale scan produces NO proposal —
the generator refuses with the reason (`stale | unreachable | no_gaps |
no_scan`), the company page's button says why before it is pressed, and the
fix is a re-scan. `proposals.scan_id` is `RESTRICT`, so the evidence a sent
proposal quotes cannot be deleted from under it. Effort is rounded to halves
ONCE, at the end — rounding each increment compounded the error. Accepting a
proposal is what closes the deal `won`, through `setDealStage` (it stamps
`closed_at`; `advanceDeal` only moves the stage).

**The ICP's `why` describes the gap, so it must never be quoted as a
strength.** The first live brief listed "Already in place: Known-outdated JS
library served in production" — the opposite of what was observed. Strengths
are signal keys, and the proposal page says "not the case here (…)" with the
wording in brackets identified as what the scan looks for.

**A meeting is a wall-clock time somewhere, and the page says where.**
`meetings.time_zone` is required; `wallClockToInstant` (`apps/web/src/lib/
wall-clock.ts`) converts the form's local time in the CHOSEN zone, not the
browser's, and is tested across DST and a half-hour zone. Meeting times are
rendered with `inZone()` in the meeting's zone — `<When>` renders in the
viewer's, which showed a 15:00 London call as "19:30 (Europe/London)" on the
first live brief. Browser-only values (the detected zone, the zone list) are
set in an effect, never in the first render: Node names a zone
`Asia/Kolkata` where Chrome says `Asia/Calcutta`, and that was a hydration
error on the public booking page.

**The booking page is the one place a stranger writes to the database.** It
is exempt from the cookie gate, bounded field by field, refuses bodies over
8 KB, reveals nothing about the org but its display name, and does not return
the meeting id (an id is a thing to enumerate with). The consent rows it
writes carry the form's exact wording as `evidence`, imported from the same
module the form renders (`lib/booking-copy.ts`) — a consent whose recorded
wording is not what the person saw is a claim. A free-mail address does not
name a company, so the row is `<address>.inbound` named after the person, for
a human to fix. Rate limiting belongs at the reverse proxy, like `/api/health`.

**Not built:** calendar invitations (a meeting recorded here moves the deal;
the invite goes from a person's calendar or the calendar connector, and
`book_meeting`'s summary says so), a proposal PDF or e-mail send (the document
is the JSON; sending anything is Phase 4's single path), and deal ownership
(`deals.owner_user_id` exists and nothing sets it yet — a two-person agency
did not need it to close).

### Voice (Phase 6, §8.5)

**The disclosure is not sent by our code, and that is the point.** §2.1 wants
the AI to say it is an AI in the FIRST utterance, and the only way to
guarantee something is first is to make it impossible for anything to
precede it. It rides as `welcomeGreeting` on the `<ConversationRelay>` noun,
so Twilio speaks it at connect before the socket exists, with
`welcomeGreetingInterruptible="none"` — the attribute defaults to `any`, so
leaving it out would let a caller talk over the disclosure. `aiDisclosure()`
in `packages/core` is its only source, so it cannot be paraphrased away.

**`calls.disclosed_ai_at` is evidence, not telemetry.** An answered call with
a NULL there did not disclose, and `callsThatDidNotDisclose()` exists so that
is a query somebody can run rather than a claim nobody can check. The /calls
page leads with it going wrong.

**Order of precedence on every turn is §2.1's, not the conversation's:**
opt-out, then a request for a person, then sentiment, and only then the
script. The first three are pure functions over the caller's own words —
never left to a model to notice, because a model having a pleasant
conversation is exactly the one that misses "stop calling me".

**An opt-out writes the suppression row, not just the column.**
`recordOptOut` does both in one call, and when the number cannot be
normalised it returns `{suppressed: false, message}` and the service logs
`OPT-OUT NOT RECORDED` at error — §2.1's Phase 4 obligation restated for
voice: an opt-out that failed to store must fail loudly to a human and never
fall through. `phoneIsSuppressed` treats an unreadable number as suppressed,
because "we could not parse it" is not "they never asked us to stop".

**There is no code path that places a call.** Not "it is disabled" — the
dialling code does not exist, which is what §2.1's "structurally impossible"
asks for. When outbound voice is built it goes through `decideSend` with
channel `voice` like every other message, and `calls_outbound_names_its_touch`
(0014) makes a row that skipped the approval unstorable.

**Every webhook fails closed.** No `TWILIO_AUTH_TOKEN` or no
`VOICE_PUBLIC_URL` means every request is refused, like
`/api/inbound/email`. The signed URL is rebuilt from `VOICE_PUBLIC_URL`,
never the Host header, because behind a proxy the URL Twilio signed is not
the one the socket saw. The relay WebSocket additionally refuses any
`setup` naming a callSid that did not arrive through a verified TwiML
webhook.

**Six findings from the Phase 6 review, all fixed, listed so nobody
re-derives them.** Two were the kind that look fine and are not:

- **The disclosure audit could never fire.** `callsThatDidNotDisclose()`
  asks for `answered_at IS NOT NULL AND disclosed_ai_at IS NULL`, and
  `answered_at` was written by exactly ONE statement — the same `.set()`
  that wrote `disclosed_ai_at`. The state it looks for was unreachable, so
  the query written to prove a §2.1 obligation could never report it being
  missed. Its test passed only because it forced the impossible state by
  hand. `markAnswered()` is now a separate write from a separate event, and
  the test drives the real sequence.
- **An opt-out lost to an exception.** `recordOptOut` handled
  `addSuppression` RETURNING `{ok:false}` but not THROWING, which is what a
  database fault actually does. The exception escaped the session, so the
  caller who asked to be left alone got no suppression, no
  `OPT-OUT NOT RECORDED` log, and silence for the rest of the call.
- **`reportInputDuringAgentSpeech` defaults to `none`**, so speech during an
  agent utterance was used to stop the TTS and then discarded — never
  reaching the socket. The disclosure promises "say stop at any time", and
  that promise was false for every second the agent was talking. Set to
  `any`.
- **Relay turns were not serialised.** Each `message` was an independent
  fire-and-forget promise, so the script kept talking after an opt-out had
  ended the call. They are chained now, which also gives the hang-up path
  something to await so it stops closing the record a turn early.
- **`endCall` was not idempotent.** The socket and the status callback race,
  and the loser rewrote an `opted_out` record with its answers into
  `incomplete` without them. The predicate now carries `ended_at IS NULL`,
  so the first close wins — while Twilio's duration and recording URL,
  which only the callback knows, still land.
- **A greeting that never played was recorded as a disclosure.** Twilio
  documents TTS failures (64111, 64112) as non-fatal: the session continues
  and the caller heard nothing. If what went unheard was the disclosure,
  the row claimed an obligation nobody met. `onRelayError` now takes the
  disclosure back and ends the call.

**A seventh, found by the end-to-end test rather than by review.** The status
callback's handler was guarded by `if (call && !call.endedAt)`, which reads
like the idempotency the socket/callback race needs. `endCall` already does
that arbitrating itself — `ended_at IS NULL` in its own WHERE — and it has a
second branch for exactly this case: when somebody closed the record first,
their outcome stands but Twilio's duration and recording URL, which ONLY the
callback knows, are still filled in. The route's guard made that branch
unreachable. And it was unreachable on every call that ends normally, because
the socket always closes before Twilio posts the callback — so the stored
duration was always the service's own arithmetic and `recording_url` was
never written at all. Neither unit test could see it: one drives the session,
the other the signature, and the bug was in the route between them.

Two more the review raised and the refuters killed, worth recording so they
are not re-fixed: discarding the `interrupt` message loses no transcript
(with `reportInputDuringAgentSpeech` set, the speech arrives as a normal
prompt), and the handoff copy was already honest. The handoff was changed
anyway, because a caller told "connecting you now" by a deployment with
nowhere to connect them is misled by this service rather than by its
configuration.

**Shutting down waits for the writes that shutting down STARTED.** Closing a
live socket fires its close event, which begins writing that call's outcome —
and nothing awaited it, so the caller closed the pool and called
`process.exit(0)` with the write in flight. A call in progress at SIGTERM
could therefore be cut off and left `in_progress` with no outcome: precisely
the state that closing the sockets was added to prevent, so that fix was only
half of one. `done()` is now MEMOISED rather than guarded by a boolean — a
guard makes the second caller return instantly while the first is still
writing, so awaiting it would wait for nothing — and `close()` calls it on
every live call explicitly, which is deterministic rather than hoping the
close event beats the exit. The test drives it with a deliberately SLOW model:
`finish()` awaits the summary, so without the fix `close()` returns before the
model answers and the row cannot carry its text.

**`index.ts` exports the service; `main.ts` starts it.** It used to call
`main()` at module scope, so importing it booted a real server against a real
pool and, on failure, called `process.exit(1)` out from under whatever
imported it — which is why the routes had no test for as long as they did.
`startVoiceService(deps)` takes its database, logger, liveness ping and model
as arguments and returns the port it actually bound, so the test drives the
same code a deployment runs. (`apps/agent/src/index.ts` still has the old
shape; it is not blocking anything and was left alone.)

**The scripted policy is the whole conversation.** `scriptedTurn` qualifies a
caller in three questions with no model involved, which is what runs when no
model is configured, what the tests drive, and the shape a model-backed
policy would have to match. A model would sit at step 4 of the precedence
above and nowhere else. Flagged rather than hidden (§13): §8.5 says "you run
the conversation loop against the model", and this ships the deterministic
half of that.

### Single-shot models (§5.5)

**The seam exists; a model behind it is optional, and that is enforced by the
signature.** Every single-shot job in this product already has a deterministic
answer — the extractive call summary, the scored findings, the templated draft.
So `attemptLlm` takes the fallback as a REQUIRED argument: a caller that cannot
produce an answer without the model has misunderstood what the seam is for, and
does not compile. Nothing throws out of it either — a refused call, an
unreachable Ollama, a model answering in a shape the caller cannot parse all
return the fallback with a `why`, so the product says what it said before
anybody configured a model.

**The default is inverted from the usual one: lead data stays local.** §5.5's
clause "local models keep lead data on their hardware, which is the point" is
read as a rule, not a rationale. `TASK_CARRIES_LEAD_DATA` marks four of the
five tasks as carrying somebody's personal data — a transcript, a reply, a
draft naming a prospect, a company's findings — and one, `polish_copy`, as the
agency's own wording carrying nobody. A task that carries lead data reaches a
REMOTE provider only when `LLM_ALLOW_REMOTE_LEAD_DATA` says so. `decideLlmCall`
is the only thing that decides, for the same reason `decideSend` is: the checks
run in one order, in one place, and a caller cannot skip one it does not
perform. `no_provider` and `task_disabled` are not errors and are not logged as
such; `lead_data_offsite` is a refusal and says which provider it refused.

**Local is DECLARED, never inferred.** `ollamaProvider` takes `local` as a flag
(default true) rather than reading the hostname, because an Ollama on a rented
box is not the agency's hardware — and inferring it from `127.0.0.1` would turn
the rule off silently for exactly the deployment that needs it.

**A provider error carries its status and never its body.** Every one of these
APIs quotes the offending request back in the error body, and that body is the
prompt — which is the lead data the rule exists to contain. `LlmProviderError`
holds `provider` and `status`. `MAX_PROMPT_CHARS` (100k) refuses a prompt far
larger than any real job before it is sent.

**The first consumer is the call summary.** `apps/voice` builds the provider
once at boot and logs `summaries: ollama (local)` or `deterministic`; the
session asks for a summary when the call closes and writes `endCall`'s
deterministic one on every failure path. Only the caller's and the agent's
turns are sent — not the system events. `classify_reply`, `draft_outreach` and
`summarise_findings` have their task keys and no caller yet; wiring them is
adding an `attemptText` call beside the deterministic answer that already
exists, never in place of it.

## 3. Commands

```bash
npm install
npm run typecheck        # packages AND tests, strict
npx tsc --build          # compile packages to dist/ only
npm test                 # 1500 tests: domain + migrations + invariants + seed + parity + agent + send path + pipeline + voice
npx vitest run --maxWorkers=1 --minWorkers=1   # the same suite on a machine short of memory
npm run build            # packages, then the Next app

# database (needs DATABASE_URL)
npm run db:migrate            # apply pending
npm run db:migrate -- status  # what is applied
npm run db:migrate -- down 1  # revert one
npm run db:migrate -- reset   # all the way down, then up (refuses in production)
npm run db:seed               # org + owner + ICP + 16 seed companies; idempotent

# scanning (Phase 1)
npm run scan                  # every company that has never been scanned
npm run scan -- --all         # re-scan everything
npm run scan -- rentman.io    # one domain
npm run scan -- --import f.csv  # import a domain,name CSV, then scan

# a local Postgres on a machine with neither Postgres nor Docker
npm run db:local              # PGlite behind a TCP socket; data in .pgdata/

# the agent (Phase 2). The API key is NOT the default path — see the credit
# note below. AGENT_USE_LOCAL_LOGIN authenticates against the Claude Code
# login and costs no credit, which is how the gates below were passed.
AGENT_USE_LOCAL_LOGIN=true npx tsx --env-file=.env apps/agent/src/index.ts
npm run smoke:agent              # the Phase 2 gate. SPENDS whatever the worker authenticates with.
npm run smoke:agent -- --draft   # ...and make it park a draft on a human
npm run smoke:agent -- --connector deepwiki   # the Phase 3 gate (§6's "no restart")

# production operations, all prompt-based so no connection string touches a
# file, an argument list or shell history (§2.3)
./tools/remote-setup.sh       # migrate + seed a remote database
./tools/run-worker.sh         # run the worker here, against production, nothing exposed
./tools/add-teammate.sh       # grant somebody access — there is no signup flow
./tools/spend.sh              # what the API has actually cost: per day, per person, run rate

# the parity harness — regenerate only when re-recording on purpose
npm run fixtures:capture      # re-record the seed domains' public surface
npm run fixtures:golden       # re-run the PYTHON engine over those recordings
npm run fixtures:html-parity  # re-run the PYTHON parser over the tag-soup corpus
npm run tables:python         # regenerate the entity/whitespace tables from CPython

# the whole stack
cp .env.example .env
# Two secrets have no safe default, and compose REFUSES TO START without
# either — a stack that half-starts is harder to diagnose than one that stops:
#   AUTH_SECRET           openssl rand -base64 32
#   AGENT_INTERNAL_TOKEN  openssl rand -base64 32   (web and worker share it)
docker compose up --build -d   # -d, or the first command holds the terminal
docker compose run --rm migrate
docker compose run --rm seed
# app        http://localhost:3000
# magic links http://localhost:8025   (Mailpit — dev only, relays nothing)
```

**The suite's memory cost is per WORKER, and that is what falls over first.**
vitest forks a worker per CPU and `freshDb()` builds an embedded Postgres in
each one — and it does that in `beforeEach`, so every individual test gets a
new PGlite instance and replays all sixteen migrations. On a machine under
memory pressure the workers fight rather than share, and the first thing to
give is `freshDb()` blowing the 30-second `hookTimeout`, which reads like a
broken test and is not one. Measured here: `apps/voice` took **945 seconds and
failed two hooks** with the default workers, and **12.9 seconds passing all 14**
with `--maxWorkers=1`, at the same 11.5 GB of swap in use. Reach for the flag
before believing a hook timeout.

**Done, and it halved the wall clock.** `migratedDb()` migrates ONCE per
process, keeps the finished data directory, and hands each test a COPY via
`loadDataDir`. The work is shared; the state is not — `loadDataDir` hydrates
a new instance rather than attaching to one. Measured: the whole suite went
from **290s to 97s** single-worker, with the same tests passing, and
`apps/voice` alone from 9.8s to 4.4s.

`freshDb()` remains and `migrations.test.ts` and `schema-parity.test.ts`
still use it — a test about applying migrations cannot start from a database
that already has them.

The obvious risk is that shared state would leak between tests and the
failure would not look like a harness bug: it would look like the product
behaving strangely, intermittently, depending on file order. That is exactly
how a suite starts passing vacuously, so it has its own test rather than an
argument in a comment. `packages/db/test/harness.test.ts` writes a row named
`LEAKED FROM THE PREVIOUS TEST` in one test and asserts the next cannot see
it, checks the migrations really are applied (down to 0017's `reply_kind`),
and re-checks the UTC pin the snapshot could have lost.

`packages/core` and `packages/db` compile to `dist/` and are consumed as
JavaScript, so **run `npx tsc --build` after changing them** or the web app
will use stale output. TypeScript project references handle the ordering.

---

## 4. Decisions and deviations

Places where this repo departs from a literal reading of PROMPT.md, and why.
Flagged rather than hidden, per §13.

**§5.5's `packages/core/llm/provider.ts` is split in two.** That file exists
and holds what its name says — the `LlmProvider` interface, the task
vocabulary, and `decideLlmCall`. It does not hold the Anthropic, OpenAI and
Ollama clients, because `packages/core` may perform no I/O and
`packages/core/test/no-io.test.ts` reads the source to prove it. The three HTTP
clients and `attemptLlm` live in `packages/llm` instead. The alternative was an
injected fetch-shaped function, which moves the import out of core without
moving the I/O out of it — the rule in §3 is about what the package DOES, not
about which line declares the dependency.

**`companies.domain` and `agent_defs.slug` are unique per org, not globally.**
§4 says `domain unique`. A global unique domain would force exactly the
migration that putting `org_id` on every table was meant to avoid, so both are
`UNIQUE (org_id, <col>)`.

**Enumerated columns are `text` + `CHECK`, not Postgres `ENUM` types.**
Verified on a real server: `ALTER TYPE ... DROP VALUE` fails outright
("dropping an enum value is not implemented") and a value added by
`ALTER TYPE ... ADD VALUE` cannot be used in the transaction that added it.
An enum migration is therefore not reversible, and §10 requires every migration
to be. A `CHECK` drops and re-adds cleanly inside one transaction.

**Migrations are hand-written `NNNN_name.up.sql` / `.down.sql` pairs** applied
by `packages/db/src/migrator.ts`, not by drizzle-kit. drizzle-kit generates
forward-only SQL and there is no `drizzle-kit down`. Use
`npx drizzle-kit export --dialect=postgresql --schema=packages/db/src/schema.ts`
as a *generator* if you want a starting point, then hand-maintain the pair.
The migrator records a sha256 over the up **and** down SQL of every applied
migration and **refuses to run if a shipped migration was edited** (§10) — an
edited down file is as dangerous as an edited up file, because `migrateDown`
removes the ledger row on the strength of whatever it does. It also refuses a
migration that issues its own BEGIN/COMMIT, which would silently void the
all-or-nothing guarantee (the plpgsql `BEGIN` that opens a function body is
correctly ignored).

**Two sources of truth, kept in step by a test.** The migrations own the
database; `packages/db/src/schema.ts` owns the types.
`packages/db/test/schema-parity.test.ts` migrates a real Postgres engine from
zero and compares every table, column and nullability against the drizzle
declarations, so drift fails CI instead of production.

**Mailpit is in the default compose stack.** §3's stack table does not mention
it. Phase 0 promises that `docker compose up` gives a working login, and a
magic link has to go *somewhere*; logging it would violate §2.3. It is dev-only,
relays nothing, and production points `SMTP_*` at the real mailboxes instead.

**Tests run on PGlite; CI also runs on real Postgres 16.** PGlite is an
embedded Postgres, so `npm test` needs no Docker and no server. But **PGlite
0.5.8 embeds Postgres 18.3, not 16** — it is a *looser* gate than production,
and will accept PG17/PG18-only syntax that PG16 rejects. The `postgres16` job
in CI runs the same migrations against a real `postgres:16-alpine` and is the
one that actually proves the deploy target. `freshDb()` pins PGlite to UTC;
without that it derives an `Etc/GMT±N` zone from the host clock and truncates
to whole hours (a developer at +05:30 silently tests at +05:00).

**A workspace reaches a container only if BOTH halves are done.** Verified by
replicating the agent runner stage's exact COPY set on disk and running its
`npm ci` (there is no Docker on the dev machine):

1. the workspace's `package.json` must be COPIED in the install stage, and
2. the workspace must be DECLARED as a dependency of what the image runs.

Copying the package.json alone creates no `node_modules/@agency/<name>` symlink
at all — npm links only the workspaces inside the install scope's dependency
graph. Declaring it without copying gives a symlink that dangles. And **`npm ci`
does not fail on either mistake**: it exits 0 and the image dies later with
`ERR_MODULE_NOT_FOUND`, with nothing red in the build. `packages/scanner` was
missing from both images this way — `apps/web` already declares it — and Phase
2's `scan_company` is what would have made it fatal.

**`packages/db/test/images.test.ts` now asserts both halves**, because the
mistake kept happening: `packages/llm` was missing from all three images the
moment it was created, and writing the test immediately turned up a second
instance nobody had noticed — neither `apps/web` nor `apps/agent` copied
`apps/voice/package.json`, which Phase 6 added after those images were written,
so both were one `docker compose up` away from the same silent break. The test
reads the workspaces off the filesystem rather than listing them, so a package
added next year is covered without anybody remembering this entry exists. It
does not build an image (there is no Docker on the dev machine); it checks the
thing that was wrong every time.

**The Dockerfiles copy the ROOT `node_modules` only.** npm workspaces hoist
every dependency to the root and symlink the workspaces as
`node_modules/@agency/* -> ../../packages/*`. There are no per-package
`node_modules` directories, so a `COPY --from=deps /app/packages/db/node_modules`
fails outright. The agent runner then re-runs
`npm ci --omit=dev --workspace @agency/agent --include-workspace-root`, which
needs *every* workspace package.json present to satisfy the lockfile — that is
why the image copies four package.json files it does not otherwise use.

**The web app's database client is lazy (`getDb()`, not a `db` const).**
`next build` evaluates route modules while collecting page data, so anything
done at import time runs during the *build*. Constructing the pool eagerly
called `env()`, which throws on a missing `DATABASE_URL` — and the Docker build
therefore failed with `Failed to collect page data for /api/health` unless
production secrets were passed to `docker build`. An image build must not need
runtime credentials. CI builds the web app with no secrets in the environment
to keep it that way. Never call `env()` or `getDb()` at module scope.

**Sign-in reveals nothing about who has access.** Membership is checked inside
`sendVerificationRequest`, not by returning `false` from the `signIn` callback.
Refusing in the callback makes @auth/core throw `AccessDenied`, which redirects
somewhere visibly different from the success path — a clean oracle that turns a
guessed address list into the exact roster worth phishing. Now a stranger and a
team member get byte-identical responses and only the member gets mail. The
callback still refuses on the *callback* leg, which is what enforces "no signup
flow" (§1).

The cost of that, stated plainly: @auth/core writes the verification-token row
before `sendVerificationRequest` runs, so an anonymous caller can now create
token rows for addresses that are not team members. They are single-use, expire
in 15 minutes, and grant nothing — but nothing prunes them and nothing rate
limits the endpoint. Phase 2's worker should sweep
`verification_tokens WHERE expires < now()`; rate limiting belongs at the
reverse proxy. This was a deliberate trade against roster disclosure, which is
the worse failure.

**`AUTH_URL` is required and `AUTH_TRUST_HOST` is tri-state.** Auth.js reads
`process.env.AUTH_URL` itself, so a zod `.default()` made the variable look
configured while Auth.js fell back to the request Host header — with
`trustHost` on, that lets a forged header choose the origin the magic link
points at. And @auth/core assigns `config.trustHost ??= …`, so passing an
explicit `false` beats its own default and every request fails `UntrustedHost`,
including in development; the config key is therefore omitted entirely when the
variable is unset.

Note the consequence: because `AUTH_URL` is now always present,
`trustHost ??= !!(AUTH_URL ?? …)` is always true, so **`AUTH_TRUST_HOST` no
longer changes anything**. That is safe rather than alarming — `reqWithEnvURL`
rewrites the request origin from `AUTH_URL`, so the Host header is not what
builds the magic link. The variable is kept because removing it would silently
change behaviour for anyone who already sets it.

**`users.email` is stored normalised, enforced by `users_email_is_normalised`.**
@auth/core lower-cases the sign-in identifier before any lookup and
@auth/drizzle-adapter then matches `users.email` *exactly*. A row stored as
`Priya@Agency.com` would be invisible to that lookup, so Auth.js would try to
create a second user and fail on `org_id NOT NULL` — locking the person out
with an opaque error. Storing only the normalised form makes the gate and the
adapter agree by construction.

**`icp_profiles.definition.signals` carries an explicit `order`, and nothing
iterates the object's keys.** `definition` is `jsonb`, and jsonb does not keep
an object's keys in the order they were written — it sorts them by length, then
bytewise. The seeded profile is authored heaviest-first; the row comes back as
`csp tls hsts trust_page outdated_js security_txt …`.

That reorders things the product shows. `strengths` is built by walking the
signals, and three pairs of signals share a weight, so the stable sort that
follows keeps the walk's order for each pair — two of the three flip
(`compliance_claim`/`security_txt` and `frame_protection`/`tls`), both inside
the six evidence lines a draft quotes. The parity harness reads the seed FILE,
so it agreed with the Python engine while the app disagreed with both.

`orderedSignals()` in `packages/core` is now the only way to walk them, and
`packages/db/test/icp-round-trip.test.ts` stores the real definition in a real
Postgres, reads it back, and asserts the score, the gap order, the strength
order and the evidence lines are identical — starting with an assertion that
jsonb really did reorder the keys, so the suite cannot pass vacuously.
A definition where only some signals carry an `order`, or where two share one,
is rejected by `parseIcpDefinition` rather than silently guessed at. Without
any `order` the fallback is the key name: not the author's intent, but at least
the same in the file and in the row. **A database seeded before this change
holds a definition with no `order` and will use that fallback; re-seed it.**

**The dashboard reads the stored ICP definition** rather than repeating §11's
numbers as literals. The threshold, channels and daily cap shown are whatever
the active `icp_profiles` row says. A dashboard displaying a threshold the
engine is not using is the same class of mistake as a finding nobody observed.

**Migration 0010's down file was edited before any deployment.** Its original
down reverted `refused` rows to `failed` without clearing `refusal_code`,
which 0009's CHECK forbids, so `db:migrate down` from 0010 could not run. The
migrator's checksum then refused the corrected file against a local database
that had applied the old one, which is exactly what it exists to do; the local
`.pgdata/` was rebuilt from zero. The rule stands — never edit a shipped
migration — and 0010 had shipped to no database but a developer's.

**Findings from the Phase 4 review, all fixed, listed so nobody re-derives
them:** a paused or done campaign was still sendable (`campaign_inactive`
refusal, step 5, humans can resolve it by re-activating); the SMTP provider
would accept a LinkedIn touch (`MessageProvider.channels`, and `dispatchTouch`
refuses a channel the provider lacks WITHOUT touching the row); two workers
could send one row (`sendOne` claims `sending` before dispatch); a contact
paused between the decision and the send was still sent (`pausedAt`
re-read before `provider.send`); a draft could be approved into a campaign
on another channel (`wrong_channel`); a redelivered inbound mail made two
replies (dedup by inbound `providerId`); a duplicate contact was a 500
(`isUniqueViolation` → a sentence); `advanceDeal` raced into two open deals
(0012's partial unique index, loser re-reads); the reconciler's `bootAt` was
taken before the worker lock, so a second worker could cancel the first's
turns; a blank consent source passed once the route suffixed it (checked
before the suffix); and `Japan`, `GMT`, `EST5EDT` — zones the runtime knows
— were refused by 0010's CHECK (0013 loosens it to the runtime's own test).

**`npm run db:local` exists because `docker compose up` needs Docker.** The
documented path is compose; a machine without it had no path at all, so
`tools/local-db.ts` puts `@electric-sql/pglite-socket` in front of PGlite and
the apps connect with an ordinary `postgres://` URL. Nothing in `apps/` or
`packages/` contains a branch for "running locally", and nothing may. Read the
next entry before trusting it for anything involving two connections.

**The local PGlite socket bridge is not a Postgres for concurrency.** It is an
excellent stand-in for SQL and schema — `npm test` runs the real migrations on
it — and it is not one for anything involving two sessions. Three limitations
were found by probing rather than by reasoning, and all three fail SILENTLY:

- **It accepted ONE TCP connection until `maxConnections` was raised.**
  `@electric-sql/pglite-socket` 0.2.11 defaults `maxConnections` to 1 and
  applies it as `net.Server.maxConnections`, so the second connection — the
  web pool's, a CLI's — is answered "Too many connections" and closed, which
  the client sees as ECONNRESET and Auth.js reports as an `AdapterError` on
  sign-in. `tools/local-db.ts` passes 64; queries are still serialised onto
  the one backend by the bridge's own queue.

- **`NOTIFY` is dropped entirely.** `pg.listen()` works in-process, but a
  `pg.Client` over the bridge receives nothing, and the bridge's source has no
  notification handling at all. A `LISTEN`-based approval waiter would hang on
  a developer's own machine, which is why the waiter polls.
- **Advisory locks do not isolate.** Two separate `pg.Client`s both get
  `pg_try_advisory_lock(k)` → `true`, and `pg_locks` shows two. The bridge
  multiplexes every TCP connection onto one PGlite backend, and Postgres lets a
  session re-take a lock it already holds. So the single-worker lock does not
  exclude a second worker locally, and two workers really do both start.

Neither is an application bug and neither is worth working around — on a real
Postgres both behave correctly. What matters is that nothing is allowed to
DEPEND on them: the waiter polls, and the restart reconciler is scoped by boot
time (below) so a second worker cannot cancel the first one's live turns even
when the lock fails to exclude it.

**`tools/scan.ts` uses a connection POOL, not a `Client`.** `recordScan` wraps
its writes in a transaction, and a transaction on a single connection is not
isolated from anything else using that connection. With four workers sharing
one `Client`, worker B's INSERTs land between worker A's BEGIN and COMMIT — so
a failure in A rolls back B's scan too — and a second BEGIN on an open
transaction is a warning Postgres logs and then ignores, merging the two.
`max` is the worker count, so each worker gets its own connection and each scan
is atomic on its own. Nothing in the test suite can catch this: PGlite is a
single embedded connection, so the suite cannot have two.

**`/api/health` is unauthenticated and hits the database.** Deliberate — an
orchestrator has to reach it — and it reports only `err.name`, never the driver
message that would carry the DSN. It is not rate limited, so sustained
anonymous traffic can occupy connections from the same pool the app uses;
`DATABASE_POOL_MAX` exists partly so that ceiling is tunable. Rate limiting
belongs with the reverse proxy in front of the VPS, not in the app.

**`/api/health` reports the schema state, and deliberately does not enforce
it.** It reads `max(version)` from `schema_migrations` and compares it against
`EXPECTED_MIGRATION` in `packages/db/src/schema-version.ts`, reporting `ok`,
`behind`, `ahead` or `unknown`. This exists because migrations are applied by a
person from a terminal, against a connection string no assistant may hold
(§2.3) — so without it, nobody deploying could confirm the migration landed,
and the failure mode is quiet: migrations only ADD, so code one migration ahead
of its database boots fine, serves every page, and then throws `column … does
not exist` the first time somebody reaches the feature that needed the column.

A disagreement returns **200**, not 503, and that is not timidity. `apps/web/
Dockerfile`'s HEALTHCHECK is `fetch(…).then(r => process.exit(r.ok ? 0 : 1))`,
so a 503 would have Docker kill the container, restart it, find the schema
still behind, and loop — serving nothing instead of the 95% that works.
Liveness ("can this process serve?") and readiness ("does this deployment agree
with its database?") are different questions and only the first may stop the
process. `?strict=1` asks the second and answers with the status code, for a
deploy gate or a human; nothing automated points at it.

The constant is hand-written rather than read from the migrations directory,
because the web bundle must not import the migrator — it resolves files through
`import.meta.url` (see `apps/web/src/lib/db.ts`). `test/schema-version.test.ts`
fails if the constant stops matching the directory, so it can only be wrong for
as long as it takes to run the suite.

**`users.org_id` is NOT NULL with no default**, so the Auth.js adapter's
`createUser` cannot succeed. That is deliberate: there is no signup flow (§1).
The `signIn` callback refuses any address without a `users` row *before* mail is
sent, and the NOT NULL is the backstop if that callback is ever bypassed.

---

## 5. The scanner port, and how it is proved (Phase 1)

`packages/scanner` and the scoring in `packages/core` are a port of the Python
engine at `~/Documents/lead-engine`. §8.3 says the rules encoded there ARE the
product, so the port is checked rather than trusted:

`packages/scanner/test/parity.test.ts` replays recorded captures of all sixteen
seed domains through both engines and asserts they agree on every signal's
observed/gap/detail, the score, the tier, the gap ordering, the headline
finding, the angle and the evidence lines — 97 assertions. Both engines read
the SAME bytes from `packages/scanner/fixtures/*.json.gz`, so a disagreement is
between the engines rather than between two moments on the internet, and the
suite runs offline.

**Three fidelity traps the parity test caught**, each of which would have
shipped silently:
1. Python's `round()` is banker's rounding — half to EVEN. `round(42.5)` is 42
   there and 43 in JavaScript. One point, straddling the qualify-at-45
   threshold. `roundHalfToEven()` in packages/core exists for this.
2. Python's HTMLParser sets its in-title flag on EVERY `<title>` element, so an
   inline SVG icon's title is appended to the page title. Taking the first
   `<title>` disagreed on lawwwing.com.
3. The CSP detail is truncated to 140 at the Python call site, before the
   generic 160 cap.

**The HTML reader is a port of `html.parser.HTMLParser`, not a regex.**
`packages/scanner/src/htmlparser.ts` reproduces CPython 3.9's parser state
machine function for function, `unescape.ts` reproduces `html.unescape`, and
`python-tables.ts` is GENERATED from Python's own tables
(`npm run tables:python`) so a 2231-entry entity table cannot drift by a typo.

It started as three regexes, which is how sixteen real pages can pass parity
while the engine is still wrong. A regex reads markup HTMLParser never reaches:
tags inside `<!--…-->`, inside marked sections, and inside a `<script>` body —
and it ends a tag at the first `>`, including one inside a quoted attribute
value. Both produce §2.2 violations in opposite directions. A commented-out IE
fallback became "jQuery 1.11.0 served in production" — a finding stated about
markup no browser executes, scoring 86 against the reference's 77. An
`<a onclick="() => go()" href="/login">` lost its href, and with it the login
surface that qualifies the lead at all: 77 and tier A became 0 and disqualified.

Real pages did not catch this because real pages are well behaved.
`packages/scanner/test/html-parity.test.ts` replays 2009 cases of deliberately
hostile tag soup — hand-written traps plus seeded random soup — through the
port and asserts it answers what the REFERENCE extractor answered when
`npm run fixtures:html-parity` ran it. The old regex reader disagrees with
Python on **1169 of those 2009**; the port disagrees on none.

**`pystr.ts` holds the Python string semantics**, because the port's length
rules and truncations are Python's and Python counts CODE POINTS where
JavaScript counts UTF-16 units. `pyLen`, `pyHead` and `pyStrip` replace
`.length`, `.slice(0, n)` and `.trim()` wherever the number came from
`signals.py`. The difference is not academic: a `/security` page of 39 emoji is
39 characters to the reference and 78 to `.length`, which decides whether it
clears the 40-character floor and whether the SPA-shell guard calls it the
homepage. And `detail[:160]` cut as UTF-16 can split a surrogate pair, leaving
half a character in a string that is then stored as `findings.evidence` and
rendered.

Details that are ported on purpose and look like bugs, because they are the
reference's behaviour and the score depends on them: an unclosed `<title>`
swallows the rest of the document (the in-title flag is never cleared); the
reference calls `feed()` and never `close()`, so a document ending mid-tag
silently loses its tail; an unknown marked-section keyword raises, which the
reference's `except Exception: pass` turns into "keep the partial result". And
Python's `\s` and `str.strip()` are not JavaScript's — Python has U+001C..U+001F
and U+0085, JavaScript has U+FEFF — so every ported regex spells the class out
from the generated `PY_SPACE_CLASS` and `pyStrip()` replaces `String.trim()`.

**The HTTP client is `node:https`, not `fetch()`.** The WHATWG Response hides
the two things this module has to get right, and the fixtures cannot show it:
the recording stores a body that is already decoded and headers that are
already a map, so a mistake made *before* the recording is invisible to parity.

1. The reference's `resp.read(1_500_000)` caps the **encoded** stream and only
   then decompresses. `fetch()` decompresses first, so the 1.5 MB cap was being
   applied to a different quantity — a gzipped page read to a different depth
   than the engine this one must agree with.
2. `Headers.get` joins repeated headers with `", "`; Python's
   `email.message.Message.get` returns the **first**. A site sending two
   `Content-Security-Policy` headers had a third, invented one quoted back to
   it as what it serves.

Owning the request also means owning the redirect chain, and `redirectTarget()`
re-checks `isScannableHost` on **every hop** — a divergence in the other
direction. urllib follows a redirect wherever it points, so refusing
`169.254.169.254` in `companies.domain` bought nothing while a company's own
site could answer `302 Location: http://169.254.169.254/` and be followed.
`Accept-Encoding` is the reference's exact `gzip, deflate` (not undici's
brotli) and redirects stop at urllib's ten.

**Four deliberate divergences, all §2 over port fidelity.**

1. Python's public-path probe does `except Exception: continue`, so a timeout,
   DNS failure or WAF block on `/security` is indistinguishable from a clean
   404 — both become "no trust page". That is the exact case §2.2 forbids. Here
   a 404 still counts as absent, because a 404 IS an observation, but silence
   from every candidate marks the signal `observed = false`.
2. A body that hit the read cap is a PREFIX of the page, and "SOC 2 is not in
   the text" is really "SOC 2 is not in the part we read". The reference cannot
   tell the difference and reports the gap. Here a **negative** result off a
   truncated body is `observed = false`; a **positive** one still stands, since
   a term found in the half that was read was genuinely read. `truncated` is
   recorded on the capture so the reason is in the evidence.
3. The redirect host check above.
4. **308 is followed.** Python 3.9's `HTTPRedirectHandler` has
   `http_error_301/302/303/307` and no `http_error_308`; support arrived in a
   later CPython. On the interpreter the reference runs, a 308 raises, and the
   engine writes the company down as UNREACHABLE. But `308 Location:
   https://www.example.com/` is the apex-to-www redirect half the hosting
   industry emits — two of the sixteen seed domains answer with exactly that,
   and both were being recorded as unreachable sites. That is a false statement
   about a company, and it is not a rule the reference chose; it is the absence
   of one in a standard library version.

All four are asserted explicitly in `packages/scanner/test/`, never hidden.

If you re-record the fixtures, the goldens must be regenerated in the same
commit, and the diff should be read: a changed score means the site changed, or
the engine did. The same goes for `fixtures/html-parity.json`, which records
what a specific CPython answered — it carries the version it was generated
with, and regenerating it on a different one is a change to the target, not a
refresh.

## 6. SDK verification (PROMPT.md §13)

§13 asks for the SDK option names to be checked against the installed package's
own types and any drift noted here. Checked against
**`@anthropic-ai/claude-agent-sdk@0.3.269`**, which is now a real dependency of
`apps/agent` — so everything below was read from `node_modules/@anthropic-ai/
claude-agent-sdk/sdk.d.ts` and `sdk.mjs` in this tree and can be re-checked
from inside the repo. (An earlier version of this section was written against
0.3.263 from a scratch install and said the SDK was not a dependency. Both were
true when written; neither is now.)

`zod` is the one peer worth pinning here: the SDK declares `zod: ^4.0.0` and
this repo pins `4.5.4`, so the v3/v4 raw-shape trap does not apply. `tool()`
takes a raw shape — `{ domain: z.string() }` — not a `z.object(...)`.

**Names that are correct as written in the spec:** `query`, `mcpServers`,
`agents`, `canUseTool`, `resume`, `forkSession`, `includePartialMessages`,
`maxTurns`, `maxBudgetUsd`, `settingSources`, `skills`, `createSdkMcpServer`,
`tool`, `sessionStore`, `permissionMode`, `systemPrompt`, `allowedTools`,
`hooks`. `mcpServers` is `Record<string, McpServerConfig>` and the stdio /
http / sse shapes match §6's `buildMcpServers` exactly.

**Drift — §5.4's pseudocode does not match the real types. Phase 2 must use
the real ones:**

1. `canUseTool` is **not** `(toolCall) => ...`. It is
   ```ts
   type CanUseTool = (
     toolName: string,
     input: Record<string, unknown>,
     options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string },
   ) => Promise<PermissionResult | null>
   ```
2. `PermissionResult` is **not** `{ allow: boolean, reason }`. It is
   ```ts
   | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
   | { behavior: 'deny'; message: string; interrupt?: boolean }
   ```
   So §5.4's `return { allow: true }` becomes `return { behavior: 'allow' }`,
   and the denial becomes
   `{ behavior: 'deny', message: 'Not approved by a human (...)' }`.
3. `AgentDefinition.tools` — passing `'Skill'` here is **deprecated**; use the
   separate `skills` field. Affects §6's skills guidance and §7's `allowedTools`.
4. `SettingSource` is `'user' | 'project' | 'local'`, so §6's
   `settingSources: ["project"]` is right.

**Other pinned-version facts worth not rediscovering:**
- `next-auth@5.0.0-beta.32` peers `next ^14 || ^15 || ^16` — Next 16 is fine.
- Use `next-auth/providers/nodemailer`; `providers/email` is deprecated and
  gives the provider id `email`, changing the callback path.
- `Nodemailer({...})` **throws without a `server` config** even when
  `sendVerificationRequest` is fully overridden.
- Under `strategy: 'database'` the `session` callback receives
  `{ ...adapterSession, user }` — returning it verbatim **publishes the raw
  `sessionToken`** from `GET /api/auth/session`. Build the object explicitly.
- Next 16 renamed `middleware.ts` to `proxy.ts`; `proxy.ts` runs on the Node
  runtime (`middleware.ts` was Edge). Shipping both is a build error.
- Next 16 dropped the `eslint` key from `next.config`.
- `pg-boss@12.30.0`: **no default export** (`import { PgBoss }`), `boss.work`
  handlers receive an **array** of jobs, and `createQueue()` is mandatory
  before `send`/`work`. **Unverified against this tree** — pg-boss is named in
  PROMPT.md §3's stack table but is in no `package.json` here and is not
  installed. These three claims came from reading the package elsewhere; check
  them against the version you actually install before relying on them.

---

## 7. Standards (PROMPT.md §10)

- TypeScript strict, plus `noUncheckedIndexedAccess`. No surviving `any`.
- Zod at every boundary — env is validated at startup in both apps.
- Domain rules in `packages/core`, pure, unit-tested against edge cases.
- Every migration reversible. **Never edit a shipped migration** — the migrator
  will refuse to run, on either half of the pair.
- `npm run typecheck` covers the shipped packages, the test suite, the CLIs
  under `tools/`, and the web app (`tsconfig.test.json` plus
  `apps/web/tsconfig.json`). The test suite is the stated proof of the §2
  invariants, so it belongs inside the type system — and so does everything
  vitest will run. `tsconfig.test.json`'s include globs must stay a superset of
  `vitest.config.ts`'s: vitest runs `apps/*/test/**`, so a test placed there
  runs whether or not anything typechecks it. `tools/*.ts` was checked by
  nothing at all until Phase 2 closed the hole.
- Structured JSON logging. Never log credentials or full message bodies.
- Conventional commits, small PRs, one phase per branch.

## 8. The agent runtime (Phase 2)

### The gate has three documented bypasses, and the spec recommends two of them

Read verbatim out of the installed SDK's own `sdk.mjs`, from the warning it
emits when you configure one:

| bypass | the SDK's words |
|---|---|
| `permissionMode: 'bypassPermissions'` | "auto-approves every tool call (except explicit deny rules) **before the callback is consulted**" |
| any **bare** `allowedTools` entry — one containing no `(`, which includes a wildcard like `mcp__apollo__*` | "Bare allowedTools entries **auto-approve the whole tool before the callback is consulted**" |
| an allow rule in a settings file | "Allow rules from settings files can also shadow the callback but **are not visible here**" |

PROMPT.md §6 recommends the wildcard for connectors and for `Skill`; §7
recommends it for `Agent`; §6 wants `settingSources: ["project"]`. §2.4 says
the gate IS `canUseTool`. §2 is labelled hard constraints and wins, so all
three are refused and this is the fifth documented divergence.

The SDK names its own mitigation, twice: *"To gate every tool call, use a
PreToolUse hook instead."* So the gate is four layers, and each exists because
the one above it can be turned off:

1. **Ring 0 — configuration.** `tools: []`, `allowedTools: []`,
   `settingSources: []`, `strictMcpConfig: true`, `permissionMode: 'default'`,
   plus `disallowedTools` naming every shell and filesystem tool. That last is
   redundant with `tools: []` on purpose: the default tool set is baked into a
   shipped binary and cannot be read from the types, so it cannot be *proved*
   empty.
2. **The policy tier.** `managedSettings` is filtered restrictive-only by the
   SDK, and exactly two surviving keys close all three bypasses ABOVE
   configuration: `allowManagedPermissionRulesOnly` (documented as ignoring
   allow rules from settings files **and from `--allowedTools`**) and
   `permissions.disableBypassPermissionsMode: 'disable'`. Do NOT add
   `permissions.defaultMode` — the filter drops it silently, so it would read
   as protection that is not there. Caveat recorded rather than hidden: this
   tier is skipped on a machine that already has an IT-managed settings tier.
3. **Ring 1 — `canUseTool`.** Returns `'ask'`-forced decisions for everything
   above low risk. **It never returns `null`**: the SDK's own doc says a null
   sends no control_response and "the tool stays blocked indefinitely —
   permission prompts have no park deadline". A hang is the worst outcome in
   the phase because it is indistinguishable from the model thinking, so a
   source test bans the literal from the file with comments stripped.
4. **Ring 2 — the `PreToolUse` hook.** Returns `'ask'` for anything above low
   risk, which FORCES the prompt even where a bare entry or a settings rule
   would have auto-approved first. It must never wait for a human:
   `HookCallbackMatcher.timeout` is **in seconds**, and a hook that parks for
   thirty minutes is denied-and-retried under a new `tool_use_id`, producing
   two cards for one intent.
5. **Ring 3 — the ledger.** Before a call is allowed, a single-use grant is
   recorded for exactly those arguments, and the in-process tool handler
   refuses without one. It is a multiset (so one approval cannot authorise an
   unbounded number of identical calls) and keyed by turn (so a grant cannot
   cross conversations). This is the ring that needs no SDK cooperation at all
   — for the bypass nobody has enumerated yet. A call that reaches a handler
   without a grant **halts the runtime**, latched, and `/readyz` reports it.

`ALLOWED_OPTION_KEYS` is frozen and asserted key-by-key, so an SDK upgrade that
introduces a new permission knob cannot be adopted silently.

### Authenticating without an API key (§13)

**The SDK does not require one, and the gate that assumed it did is what kept
Phases 2 and 3 unproven for the whole build.** `chat_disabled` was keyed on
`ANTHROPIC_API_KEY` being set — a narrower question than the one it meant.
The SDK's own types list the alternatives: `apiKeySource: 'none'` is
*"no API key in use - e.g. claude.ai OAuth login"*, `apiProvider: 'firstParty'`
is where *"Anthropic OAuth login"* applies, and `oauth_org_not_allowed` is one
of its error variants. The worker now resolves an `AgentCredential` once at
boot and every gate reads that instead.

**`AGENT_USE_LOCAL_LOGIN` authenticates as a PERSON, and is refused in
production by `loadEnv` rather than by a comment.** The credential is one
human's, it lives in their OS keychain, and it is created by an interactive
flow no server has. A shared service standing behind it cannot be billed,
rate-limited, audited or revoked separately from them — §2.3's concern exactly
— so the schema makes it impossible rather than inadvisable. It also WINS over
an `ANTHROPIC_API_KEY` that happens to be in the environment: a developer's
`.env` nearly always holds a stale or revoked one, and letting the ambient
value beat the explicit instruction means the operator asks for their own
login and debugs somebody else's 401. Declared, not inferred — the same rule
as `OLLAMA_IS_LOCAL`.

**`childEnv` passes `USER`, and that line cost an afternoon.** The child's
environment is built from scratch (§2.3), and the CLI looks its stored session
up in the keychain BY USERNAME — so with `USER` absent it finds nothing and
reports itself logged out. What that surfaces as is the reason it is
commented in the source: the turn dies with *"Anthropic rejected the API
key"*, a sentence about a key that was never sent, which sends whoever reads
it to check a credential instead of an environment. Measured rather than
reasoned: `auth status` answers `loggedIn: false` under `env -i PATH HOME` and
`true` the moment `USER` is added back, and it is `USER` specifically —
`LOGNAME`, `SHELL` and `TMPDIR` all leave it logged out.

**`pathToClaudeCodeExecutable` is in `ALLOWED_OPTION_KEYS` deliberately.** The
SDK ships no CLI — it drives one — and resolves `claude` from PATH. A machine
whose only copy arrived with the desktop app has it under Application Support
and nothing on PATH, and the resulting failure also reads like an auth
problem. Note the desktop app's own login is NOT the CLI's: they are separate
keychain identities, so `claude auth login` has to be run for the binary the
SDK will actually spawn.

**Credits are limited, so the local login is the DEFAULT for development, not
a fallback.** The API balance is prepaid. One heavy agentic turn measured
$0.124 here — 22 tool calls, 284 events — so a handful of casual verification
runs is a real fraction of it. Never reach for the API key to check that
something works: run the worker with `AGENT_USE_LOCAL_LOGIN=true`, which costs
nothing and is the path both Definition-of-Done gates were passed on. The key
is for the DEPLOYED worker, where teammates' turns run and a personal
subscription cannot legitimately stand behind a shared service.

`AGENT_MODEL` defaults to `claude-haiku-4-5` in `.env.example` for the same
reason: Haiku is $1/$5 per MTok against Opus-tier's $5/$25, and "score the
pipeline, draft an opener" sits well inside what it does. `./tools/spend.sh`
reports what has actually been spent — per day, per person, and a run rate —
from `chat_messages.cost_usd`, which is the SDK's own figure rather than an
estimate.

**`tokens_in` counted only the UNCACHED input, which is not a small number but
a wrong one.** `usage.input_tokens` excludes what the cache served, and this
product caches hard on purpose (a frozen system prompt, a deterministic tool
list) — so a real turn recorded EIGHT input tokens against 2,485 out.
`cost_usd` was right throughout because the SDK computes it, so nothing was
mis-billed; but anyone reading `tokens_in` to attribute spend per person was
reading close to zero. It now sums `input_tokens`, `cache_read_input_tokens`
and `cache_creation_input_tokens`. Found while pricing the API for a team.

**An organisation-scoped key looks broken and is not.** It authenticates, and
then every request — `/v1/messages` included — comes back
`400 invalid_request_error`: *"This API key is not scoped to a workspace, so
this request must include the anthropic-workspace-id header"*. A 400 rather
than a 401 means it does not read as a credential problem at all. Either use a
WORKSPACE-SCOPED key (preferred: no extra configuration, and the workspace can
carry its own spend limit, which is worth having on a small balance) or set
`ANTHROPIC_WORKSPACE_ID` in this repo's env, which the worker converts into
the header.

**Do not reach for the SDK's own `ANTHROPIC_WORKSPACE_ID` to do that.** It
reads that variable — which is precisely the trap — but only on the Workload
Identity Federation path, beside `ANTHROPIC_FEDERATION_RULE_ID` and
`ANTHROPIC_SERVICE_ACCOUNT_ID`. An `x-api-key` request ignores it, so setting
it looks like a fix and changes nothing. What works is
`ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: <id>'`, measured by
running the CLI both ways: it answers a prompt with the header and fails
without it. `childEnv` builds the child's environment from scratch, so that
variable has to be named there or it is stripped — the `USER` bug's shape
exactly, and with the same misleading symptom.

**Measured on Haiku, through the worker, on the API key:** the Phase 2 gate
passed for **$0.0148** — 4 tool calls, 133 events. The same gate on the SDK's
default model cost $0.124. That is the `AGENT_MODEL` lever, worth roughly 8×.

**What this is and is not.** It is how a developer proves the Definitions of
Done on their own machine without buying credit. It is not a deployment
story: production sets `ANTHROPIC_API_KEY`, and the Vercel half has no worker
at all (a long-running process cannot live on serverless), so chat there is
absent rather than differently-authenticated.

### The approval wait polls, and that is deliberate

`LISTEN/NOTIFY` is the obvious design and it is wrong here. `pg.Pool` cannot
receive notifications at all — `pool.query('LISTEN x')` appears to succeed and
silently delivers nothing. Notifications are not durable, so a decision landing
between the insert and the subscribe is lost and a correct design needs the
poll underneath anyway. And the local socket bridge drops NOTIFY entirely, so a
LISTEN-only waiter hangs on a developer's own machine.

The waiter tolerates a transient database failure rather than denying a live
approval: a two-second blip during a twenty-minute wait would otherwise
permanently deny a request while the row stays pending and the human approves
into nothing.

### A turn always ends

`turn_finished` is emitted from a `finally`, exactly once, on every path —
crash, timeout, interrupt, budget refusal, claim refusal. The conversation
claim is released on all of them. A turn that simply stops producing events
leaves a spinner that never resolves.

Two bounds the SDK does not provide: `maxTurns` and `maxBudgetUsd` bound ONE
turn, so twenty $2 turns in an hour sits inside every SDK limit — one query
against `chat_messages` refuses past `AGENT_SESSION_BUDGET_USD`. And a session
claim stops two browser tabs starting concurrent turns on one thread, which
would splice two exchanges into a single SDK transcript.

`AGENT_TURN_TIMEOUT_MINUTES` must EXCEED `APPROVAL_TTL_MINUTES`, and the worker
refuses to boot otherwise: a turn killed while its own approval is still live
means a human's decision lands on a turn that no longer exists to consume it.

### Restart recovery is scoped by boot time, not by the lock

A killed worker leaves a conversation marked as running (a browser reattaching
spins forever) and approvals still pending (a person approves into nothing).
Both are cleared before the HTTP server accepts a turn, and both leave a
`system` message and an audit row.

That reconciliation is scoped by `bootAt`: only a turn or approval that
PREDATES the boot can have been orphaned. The single-worker advisory lock is a
second layer rather than the first, because it cannot be verified everywhere —
see the PGlite socket bridge note in §4.

### Costs are strings, and the SDK's total is cumulative

`chat_messages.cost_usd` is drizzle `numeric` with no mode, so it is a STRING
on insert and select — `"0.01" + "0.02"` is `"0.010.02"`, which stores fine and
reads as a number to nobody. Every value crosses through `usd()` and every
total is summed by Postgres.

`result.total_cost_usd` is documented as **cumulative**: "each result carries
the running total so far". The turn cost is a delta. Treating it as per-turn
bills a long conversation several times over.

### What is deliberately not built

`draft_outreach` by that name (§6 lists it): a draft is `queue_touch` parked
on a human, which is Phase 4's single send path. `get_pipeline` and
`update_deal` were held back until Phase 5 gave `deals` a writer — §12
forbids a tool that teaches the model a false shape of the business — and
ship now, with `book_meeting` beside them; all three write internal state
only and say in their summary that nothing was sent.

And §6's **skill-upload UI** — see the skills section above for why. Everything
else in §6 and §7 ships.
