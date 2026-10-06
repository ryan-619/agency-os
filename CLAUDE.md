# Agency OS — architecture, invariants, commands

Internal operating system for a small application-security agency. Read
[PROMPT.md](PROMPT.md) for the full build spec; this file is the working
summary a session should read first.

**Current state: Phases 0–6 are built, and every Definition of Done is proved** — see the table below for exactly what "proved" means for each, and what it does not. Phase 6 is built but deliberately NOT switched on: §12 says not to before A2P 10DLC registration clears, so the compose service sits behind a `voice` profile and `docker compose up` does not start it.

**After the phases, one release on migration 0018** added the operating layer
around the pipeline: an inbox for replies, notes and tasks, a consent ledger,
compliance and audit pages, search and CSV exports, the settings pages,
proposal print and buyer share links, LinkedIn steps a person sends, bounce
handling, one-click unsubscribe, a worker heartbeat, and two Vercel crons (a
nightly rescan and a Slack digest). The agent's own tools went from nine to
twenty-three. Everything web-side works with no worker; §2 describes each
piece and §4 the decisions behind them, and DEPLOYING.md carries the release
checklist, which applies the migrations BEFORE the code that reads them.

**Then SMS through DoveSoft, on migration 0019** (§2, "SMS through DoveSoft"):
the DLT-registered templates an Indian SMS must be sent from
(`message_templates`), the template every outbound SMS names
(`touches.template_id`), the operator's delivery reports beside `status`, a
worker provider that texts only words a person approved, rendered from a
registered template, to somebody who opted in to SMS, the two webhooks
DoveSoft pushes reports and texts back to, and `/settings/templates`. It is
tested against a fetch that records and never sends, and against PGlite —
never against DoveSoft itself, whose push formats and `mobiles` format are
assumptions to confirm before a real send. Calls
and WhatsApp over DoveSoft are not built: DoveSoft publishes no API for
either. Fifteen review rounds, and the follow-ups they left open, have been fixed
on top of both releases; each fix is stated below where the rule it changed
lives.

**Then the operator's tools (2026-10-06), on no migration** (§2, "The
operator's tools"): chat runs the CRM it reads — companies and people, pauses
and suppressions, campaigns and enrolment, what waits on `/approvals`,
proposals, meetings, deal owners and tasks — and, in place of a terminal, the
worker itself: its heartbeat and health, its recent warnings, the outbound
queue, and a re-scan of a few stale companies. The `agency` server has
forty-nine tools: twenty-six low (reads and scans, which run at once), twenty
medium and three high, and every medium and high call still raises an
approval card before it runs — the gate is unchanged (§8). Whether internal
writes should run without a card is a decision about the gate, the
operator's to make; until it is made, they ask.

**For now the agency runs the worker on the operator's own machine**
(`./tools/run-worker.sh`, DEPLOYING.md "Running the worker on your own
machine"), which needs no public address, because everything but chat is
the worker reaching out. Chat is the script's one opt-in inbound route: an
ngrok tunnel on the operator's free static domain to the worker's API port,
with `AGENT_URL` and the same `AGENT_INTERNAL_TOKEN` set in Vercel once
(DEPLOYING.md, "If you do want chat on the live site"). Since review round
15 ngrok runs with `--inspect=false` (its inspector kept every forwarded
request, the bearer included, on an unauthenticated `127.0.0.1:4040`), chat
is ON only once ngrok's log says the tunnel on that domain started, a watcher
stops ngrok when the worker exits, a tunnel an earlier run left on the port
is stopped first (matched only where the command line STARTS with ngrok — an
unanchored `pkill -f` killed the shell running the tests), a key or token
exported in the calling shell is never used, and a saved token can be
`copy`'d to the clipboard again or replaced. And a malformed `AGENT_URL` or
`AGENT_INTERNAL_TOKEN` in Vercel turns CHAT off rather than the site: the
two are read loosely by `env()` and judged by `agentConfigFrom`
(`apps/web/src/lib/agent-config.ts`), the one reader `lib/agent.ts` and
`flagsFrom` share, because `env()` throws for every route on any failure —
on 2026-10-02 one did, and every page, the one-click unsubscribe and every
inbound webhook answered 500 while `/api/health` blamed the database. A
configuration that does not parse throws `InvalidEnvironmentError`, which
`/api/health` reports as `config: invalid`, the deploy gate prints, and the
unsubscribe POST now catches and logs `OPT-OUT NOT RECORDED`. Behind the
tunnel `fetch` never throws, so a refused turn is read from what answered
(`refusalFromUpstream` in `apps/web/src/lib/agent-refusal.ts`): ngrok's own
page (its `ngrok-error-code` header) or anything not in the worker's JSON
shape is `agent_unreachable` — "the computer running it may be off or
asleep, or its tunnel is down" — and the worker's 401 is
`agent_token_refused`, where the panel said "The agent could not start" of
all three. An approved email's card says it goes on the next pass of "a
worker that sends email" (`EMAIL_APPROVED`), never that "the worker will
send it", because AGENT_URL says where chat goes and the laptop worker is
asked separately whether to send; and the script's chat-OFF summary no
longer says the panel shows no worker while an earlier run's `AGENT_URL`
may still be set in Vercel. The script asks a server name until it is one and Google's IMAP username until
it is a whole address, because a mistyped host reconnected every five
minutes for ever; and the worker's reconnect line now carries `reason` (the
error's code or the server's, e.g. `ENOTFOUND`, `authentication_failed`)
and a `hint`, never the message (`imapFailure` in
`apps/agent/src/outreach/inbox.ts`), where it said only `Error`. **Fly.io is the path once it rents a machine**
(`fly.toml` at the repo root), and its
defaults are the dangerous part: Fly scales a machine to zero between
requests, which is Vercel's problem wearing a different hat — the advisory
lock drops, the fifteen-second tick stops, and nothing looks broken because
`/readyz` answers fine on a machine that was just woken. `auto_stop_machines`
off and a floor of one machine are load-bearing. Only `DATABASE_URL` (direct,
unpooled) and `AGENT_INTERNAL_TOKEN` are required; **`ANTHROPIC_API_KEY` is
optional and the worker is worth deploying without one** — sending, reply
detection, stuck-send recovery, the restart reconciler and the sign-in-token
sweep all run with no model, and only chat reports `chat_disabled`. Each
worker upserts a `worker_heartbeats` row (keyed `hostname:pid`) every
`OUTREACH_TICK_MS`, so a machine scaled to zero is a growing
`worker.ageSeconds` in `/api/health` rather than an inference.

**The web half is LIVE on Vercel** at **https://myagencyos.in** (first
deployed as `agency-os-tau-murex.vercel.app`), against a Neon Postgres (18.6)
with Resend for magic links, seeded. The code expects migration **0019**
(`EXPECTED_MIGRATION`), and production is on 0019: it was at 0017 when the
0018 release was written, and the release run's Vercel build applied 0018
and then 0019 before `next build` (`tools/vercel-build-migrate.mjs`, under
`AGENCY_MIGRATE_ON_BUILD=1`). A migration is always applied BEFORE the code
that reads it deploys, never after — DEPLOYING.md, "migrate FIRST", and
GO-LIVE.md Part 2b. That is done from GitHub, with no credential on a
laptop: the hand-run **Production** workflow
(`.github/workflows/production.yml`, running `tools/production.sh`) has the
actions `status`, `migrate`, `deploy`, `release` (migrate, then deploy, then
wait for `/api/health?strict=1` to report the checkout's migration) and
`worker` (deploy `apps/agent` to Fly and point the web app at it — refused
before anything is created or deployed unless production already has the
checkout's `EXPECTED_MIGRATION`, because it never migrates and must not run
ahead of its schema; run `release` from that ref first — and refused
without `PRODUCTION_DATABASE_URL`, because the job that holds the worker's
secrets never runs the Vercel CLI that `vercel pull` needs), each but
`status` confirmed by typing its name. **`worker` is two JOBS** (review
round 8): `worker (Fly)` receives the worker's own secrets in its script
step alone (review round 6), deploys to Fly, and sets `AGENT_URL`,
`AGENT_INTERNAL_TOKEN` and a non-secret `AGENT_INTERNAL_TOKEN_PENDING`
through our own `tools/vercel-env.mjs`; `worker (web redeploy)`
(`worker-web`), on a fresh VM handed `VERCEL_*` alone — and `REDEPLOY`, the
`worker` job's one non-secret output as it arrived — runs the Vercel CLI
to redeploy the web app, waits for `/api/health?strict=1`, promotes the
pending record to the `AGENT_INTERNAL_TOKEN_WIRED` marker LAST, and waits
for the worker to show live. When `REDEPLOY` arrived `true` and no record
of this run can be read, it dies, because the live web app still runs on
the old token — unless a LATER run's record is there AND that run's own
web job has promoted it to `AGENT_INTERNAL_TOKEN_WIRED`, which is a re-run
of an old run's web job and passes (`vercel-env.mjs superseded <FROM>
<TO>`, comparing run ids, then the marker; review rounds 9 and 10). A later
run whose own web job has not finished stops the re-run: "Workflow run <id>
set a newer token and its web job has not finished — re-run that run's
worker-web job, or the worker action." — because that record is the later
run's FIRST job's, and says only that it set a newer token, not that the
web app was redeployed with it. An empty later record (`<run>/`, Fly gave
that run no digest), which no web job can promote, passes with a warning
that its web job could not be checked. The helper prints the later run's
id, and only that, on stdout, and `production.sh` reads it directly rather
than through `vercel_env`, whose `die` would print into the substitution. A
dropped output still reads the record alone,
fail-open. Round 7 drew the line at a step, and a step is
not a credential boundary: `tools/production.sh` un-exported the secrets and
ran the Vercel CLI — which `npx` installs at run time, and whose `build`
runs the whole web build — under `env -u` for each, which changes only what
a child INHERITS; any process running as the same user reads them from
`/proc/<pid>/environ` of the shells above it. Only a job boundary contains
them. `WORKER_ONLY` still un-exports them, hands flyctl `FLY_API_TOKEN`
alone and unsets the rest once Fly has staged them, and in the `worker`
action every path to the Vercel CLI dies (`no_vercel_cli`). A new worker
secret is named in the `worker` job's script step AND in `WORKER_ONLY` —
never in `worker-web` — and `production-tooling.test.ts` fails when the two
lists differ or a `WORKER_ONLY` name appears in any other job. DEPLOYING.md
says what each needs.
Proved live: `/api/health` reports
`database: ok`, `/signin` renders, `/book/agency` serves the public booking
page (it 404'd until the seed claimed the slug), and a sign-in request logged
`magic link sent`. See [DEPLOYING.md](DEPLOYING.md) — including the two things
a LOCAL `vercel build` gets wrong (it traces `.env` into the upload; deploying
from `apps/web` cannot resolve the hoisted `node_modules`). The agent worker is
NOT on Vercel and cannot be on serverless, so chat, email and SMS sending and
IMAP reply detection happen only where a worker runs — the operator's
machine, for now — and every screen that would promise them says so
instead. What does NOT need it: replies through Resend's signed
webhook, DoveSoft's delivery reports and texts sent back (two web routes),
LinkedIn steps a person sends from `/tasks`, and the rescan and digest crons.

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
| Phase 3 | **PASSED.** The agent named `mcp__deepwiki__ask_wiki_question`, `read_wiki_contents` and `read_wiki_structure` alongside its own nine (the `agency` server has forty-nine tools now), on a worker that had been running since BEFORE the connector row was written — §6's "no restart" promise, in the sequence that actually tests it | the agent *calling* a connector's tool in anger (it enumerates them; the gate asks it to enumerate); and the gate has NOT been re-run since connectors moved off the CLI's argv onto `setMcpServers` (§2, "The runtime is assembled") — that hand-over is verified against the real CLI 2.1.269 binary with no model call, and `npm run smoke:agent -- --connector deepwiki` should pass again before Phase 3 is claimed on it |
| Phase 4 | draft → approved in the UI → deferred for quiet hours (live, 21:50 London) → sent in a real SMTP transaction → deal `contacted` → a reply by Message-ID pauses, ties, moves the deal to `replied` → "unsubscribe" suppresses. One test per §2.1 rule. | deliverability through a real mailbox; IMAP IDLE against a live server (the drain on new mail and the retry of a message that failed to record are proved against a fake mailbox that models imapflow's `idle()`, `apps/agent/test/inbox-drain.test.ts`); a provider webhook with a real secret |
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
- **An SMS needs an opt-in, a registered DLT template, and a person (0019).**
  `decideSend` refuses an SMS with no GRANTED SMS consent row
  (`cold_channel_forbidden`), and one whose words are not a registered,
  active template with its slots filled (`no_template`, `template_mismatch`
  — a link or a call-back number a slot was not registered for is a
  mismatch, judged on the rendered text) — nobody may approve past any of
  the three. `touches_sms_and_whatsapp_name_a_template`
  makes an outbound SMS that can still go out unstorable without a template,
  and `touches.template_id` references `(id, org_id, channel)`, so it can
  only name a template of its own org AND channel. An SMS campaign never
  auto-sends (the CHECK above, and `campaignInput` refuses it with a
  sentence), and enrolment refuses an SMS campaign whole: each SMS is drafted
  for one person with Draft SMS. A STOP texted back is the opt-out — a phone
  suppression, source `reply` (or `voice` when the voice service's number
  received it), or the loud `opt_out_not_recorded` path when it cannot be
  written (§2, "SMS through DoveSoft").
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
  a second, unsuppressed row. `packages/core`'s `normalise()` helpers produce
  that shape, and the database refuses anything else.
  **Phase 4 obligation:** a suppression insert that fails is an opt-out that was
  never recorded — worse than the bug this constraint replaced. When
  `normalise()` cannot parse an inbound number or address, the send path must
  fail loudly and route it to a human, and must never fall through to sending.
  Every geo the seeded ICP targets is covered by a test in
  `packages/db/test/invariants.test.ts`.
- Quiet hours are stored as wall-clock times and evaluated in the
  **recipient's** timezone, by `decideSend` (§2, "The send path").
- **Which path recorded an opt-out is a fact (0018).**
  `suppressions_source_is_known` admits `manual`, `reply`, `voice`,
  `unsubscribe` and `erasure` — one per writer, and a value nothing writes is
  not listed. The column is NULLABLE: a row written before it existed was not
  tracked, and calling it `manual` would be a claim. `voice` is the voice
  service, which records what its number receives, spoken or TEXTED: its
  inbound SMS STOP wrote no source until review round 3, so every such
  opt-out was stored NULL and `/compliance` counted it as written before
  0018. Its `/sms` handler reads a text with `smsTextAsksToStop` — the
  reading DoveSoft's texts are recorded by — as well as the spoken reader it
  always used, so STOPALL, UNSUB, CANCEL, END and QUIT texted to it are
  `voice` phone suppressions (review round 5); with the spoken reader alone
  they were opt-outs to DoveSoft's webhook and ordinary texts here. A STOP
  texted to DoveSoft's number is a reply (`reply`).
- **A refusal is final until an owner lifts it.** `contactsRecordConsent`
  refuses a grant over a recorded refusal (`refused_is_final`), and the rule
  is IN the statement, not only in the read before it: `contactsConsentUpsert`
  is `ON CONFLICT … DO UPDATE … WHERE consents.granted OR NOT
  excluded.granted`, because under READ COMMITTED a grant that read "never
  asked" and lost the race to a refusal overwrote it. `contactsLiftRefusal` is
  the one audited way (`consent.refusal_lifted`) a refusal goes — back to
  NEVER ASKED, never to granted — and its DELETE and that audit row are one
  transaction. The route gates the lift to owners.
- **A bounce is not an opt-out.** `contacts_bounce_has_code` keeps
  `email_bounced_at` and `email_bounce_code` NULL together, and (0019)
  `contacts_bounce_code_is_rfc3463` makes the code an RFC 3463 status — 0018
  paired the NULLs only, while this line already claimed the format; the
  mark is lifted only by `contactsUpdate` changing the
  address, in the same UPDATE. It is a column and a `bounced` refusal, never a
  suppression row (§2, "A bounce is evidence about an address").
- **An SMS delivery report sits BESIDE `status`, never in it (0019).**
  `touches.delivery_status` (`pending`, `delivered`, `failed`),
  `delivered_at` and `delivery_error` are outbound only
  (`touches_delivery_is_outbound_only`), a delivered row carries a time —
  when the report reached the web, since no time is read from a report — and
  a failed one its bounded reason (`touches_delivered_has_its_time`,
  `touches_delivery_failure_has_its_reason`, compared with `IS NOT DISTINCT
  FROM` because a CHECK passes on NULL). `status` stays the send path's word:
  `DELIVRD` does not move it, so the cap, enrolment's duplicate guard and the
  compliance counts read every row as before, and the sender's own
  predicates have no second writer to arbitrate against. A failed delivery,
  like a bounce, is evidence about one attempt to one number and never a
  suppression. One inbound SMS is one row: `touches_inbound_sms_provider_id_key`
  is the partial unique index that settles two deliveries of one message.
- **A reply is handled by a person, and only a reply.**
  `touches_handled_is_inbound_only` and `touches_handled_has_who` (a handled
  row names who, RESTRICT). An answer to a reply is OUTBOUND
  (`touches_answer_is_outbound`), and the trigger
  `touches_answer_names_an_inbound_row_in_the_same_org` — INSERT and UPDATE,
  because a CHECK cannot see another row — refuses an answer whose parent is
  outbound or in another org, which `dispatchTouch` would otherwise thread
  into a conversation that is not its own.
- **A LinkedIn step is one task per message.** `tasks_linkedin_send_names_touch`
  and the partial unique index `tasks_one_open_per_touch`: two callers
  materialising the same draft produce one open task, and the loser re-reads.
- **A person in one org can never be named by a row in another.** 0018 gives
  `users` and `contacts` a `UNIQUE (id, org_id)` and every column it adds that
  names one — `touches.handled_by`, `notes.contact_id`/`author_user_id`,
  `tasks.assignee_user_id`/`created_by`/`done_by`, `proposal_shares.created_by`
  — references the PAIR, the shape 0006 gave `findings` and `scores`. The two
  nullable user columns use `ON DELETE SET NULL (column)`, which names the
  column so the NOT NULL `org_id` is never nulled with it; that is Postgres 15+
  syntax, and CI's `postgres:16` job is what proves the deploy target takes it.

### Evidence integrity (§2.2)
**The app must never state a finding it did not observe.** Five separate
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

5. `findings_informational_carries_no_weight` (0018) — `scored OR weight = 0`.
   The scanner now records thirteen observations the ICP does not score
   (§2, "Informational signals"). `recordScan` writes `scored` as "is this key
   an own property of the ICP's signals", so a non-ICP key is stored at weight
   0 by construction, and `quotableFindings`, the proposal (its scope AND the
   buyer-facing "Of N signals observed" count) and the meeting brief all leave
   `scored = false` rows out. "Also observed" can never be read as a gap that
   counts. The proposal still LOOKS at them, only to notice a scan recorded
   before a signal was promoted (`rescore`, §2 "The pipeline").

**`findings.stale` is a cache, not the answer.** `markStaleFindings` writes it
and `npm run scan` calls that on every run, so the column is current as of the
last scan and no more. A finding that aged past the threshold an hour ago still
has `stale = false` on it. The nightly rescan cron keeps the column current
for the companies it reaches, and it is still a cache.

So **freshness is DERIVED from the scan's `ran_at`**, by `isStale()` in
`packages/core/src/freshness.ts`, everywhere it decides whether something may
be shown or quoted: `quotableFindings`, the company detail page,
`npm run scan -- --stale`, and the send path. Reading the column instead is
how a three-week-old gap rendered with no mark on it, and how `--stale` —
which filtered on `lastScanAt === null`, a copy of the never-scanned filter —
could never pick a single company it existed to re-verify. The column is still
narrowed on first where it is indexed and cheap, but never on its own.

**And the rule is kept at SENDING, not only at writing.** A draft quotes the
scan that was current when it was written, and a deferral — the cap, quiet
hours, a paused campaign — can hold it for weeks while the rescan cron
refreshes the scan and never the words. So `sendFactsFor` takes a REQUIRED
`evidenceAsOf`, an `EvidenceAsOf`: `StoredWords { touchId, writtenAt }` for a
stored message, through the exported `evidenceAsOfFor(touch)`; a `Date` for
words written at that instant and stored nowhere (a dry run); or null for an
answer to a reply, which quotes no scan. It sets the required
`SendFacts.evidenceStale` from the latest `ok = true` scan of the contact's
company at or before that moment, judged by `isStale` on its `ran_at` at the
moment of sending, at the threshold `staleAfterDaysOf` reads from the active
ICP. For a stored message that scan is found IN SQL, against the row's stored
`created_at` — the compliance count's own predicate, so the two cannot
disagree about which scan the words quote. It used to compare `ran_at` with
`created_at` read back as a millisecond `Date`, and a scan stamped inside the
draft's millisecond, a few hundred microseconds before the words, was not
seen (`packages/db/test/evidence-moment.test.ts`). A re-scan after the words
were written does not freshen them; a new draft does. And **superseded is
stale too** (review round 3): words whose scan a NEWER successful scan of the
company has superseded set `evidenceStale` as well — asked in the same
statement, against the stored `ran_at`, with the scan excluded by id — because
the newer scan may observe a quoted gap as closed, and only the latest is
quoted in anything outbound (`quotableFindings`' rule, and the share link's).
A newer scan that did not reach the site supersedes nothing. `decideSend`
refuses either `stale_evidence` (§2, "The send path"), and `decideGathered`
in `packages/db/src/outreach.ts` words a superseded one for what happened ("A
newer scan of this company has reached the site since the scan these words
quote…") unless the scan is also past its deadline.

**The threshold has one reader.** `staleAfterDaysOf(definition)` in
`packages/core/src/freshness.ts` is how every caller reads
`freshness.stale_after_days` — the sender, enrolment, the proposal and the
share link, the meeting brief, the rescan, the digest, `tools/scan.ts`, the
agent's tools and every page (the web's `readIcp` delegates to it): the
value when it is a finite positive number, and 14 for no profile, a
definition `parseIcpDefinition` refuses, no `freshness` block, or anything
else. `isStale` throws on a non-positive threshold, and readers that passed
the raw value made a hand-edited `0` a 500 on the proposal and company
pages, the share link and two agent tools while `/compliance` fell back to
the default — the page and the tool that must agree did not.
`/settings/icp` names a refused value ("this profile sets 0, which is not a
positive number of days, so every reader uses the product default") rather
than displaying it as the threshold, and the company page reads a profile
that does not parse as no profile rather than answering 500. A source pin,
`stale-threshold-readers.test.ts` in `packages/db/test` and `apps/web/test`,
keeps every reader on the helper.

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
  `packages/db/src/safe-target.ts` (which the migration CLI prints through)
  prints `host:port/db` and never the DSN.
- `redact()` in `packages/core` walks nested objects and arrays and blanks any
  value whose **key** looks sensitive; both loggers use it. It is a backstop,
  not the primary defence — it matches on key name only, so a credential under
  an innocuous key (`{ value: 'sk-live-…' }`) still gets through. Do not read
  it as permission to log arbitrary objects. `packages/core/test/redact.test.ts`
  pins that limitation as an explicit test.
- `sendVerificationRequest` deliberately does **not** log the magic-link URL.
  That URL is a bearer credential.
- **Three more URLs are credentials, and are treated as such.** The Slack
  webhook URL (never logged, never in an audit row — `redact()` cannot see it,
  because it is a value in a URL rather than under a key), which the worker
  now holds too, under the same rules, for its one alarm (§2, "Notifications
  and the heartbeat"); a proposal share
  token, of which only the sha256 is stored — `proposal_shares_token_hash_shape`
  (`^[0-9a-f]{64}$`) makes a raw token unstorable; and an unsubscribe token,
  which names one message and nothing else. A Resend attachment's
  `download_url` is a signed bearer link of its own and is never logged
  either.
- **The DoveSoft key goes in one header and nowhere else.** `DOVESOFT_API_KEY`
  lives in the provider's closure and the `key` request header — never a
  property of the provider object, an error's message or name, a log line or
  an audit row — and the request sets `redirect: 'error'`, because `fetch`
  strips only `Authorization` across origins and a redirect would carry the
  `key` header wherever it pointed. In production `DOVESOFT_BASE_URL` must be
  `https:` on a public multi-label host or the worker refuses to boot, naming
  the variable and never the value. `DOVESOFT_WEBHOOK_SECRET` is compared in
  constant time and never logged by this code — but a `?token=` in a URL
  lands in the platform's access log, which is why the `x-dovesoft-token`
  header is the form to register where DoveSoft can send one, and why
  `/settings/deployment` prints the URLs with a `<DOVESOFT_WEBHOOK_SECRET>`
  placeholder rather than the secret. A GET push of an inbound text puts
  more than the token there: the sender's NUMBER and the WORDS ride in the
  same URL, into Vercel's request log and DoveSoft's own, so POST is the
  form to ask DoveSoft for (§2, "SMS through DoveSoft"). Generate the secret
  with `openssl rand -hex 32`, which needs no escaping in a URL; any other
  character is percent-encoded there.
- **A session cookie's value is a bearer credential too.** The scanner records
  each homepage `Set-Cookie` for `cookie_flags` with its VALUE replaced by
  `<redacted>` — the rule reads names and attributes only.
- **Where a connector's credential goes is a NAME in its config**
  (`secretEnv`, `secretHeader`, `secretPrefix`), never the value. A `headers`
  or `env` entry whose key or value looks like a credential is refused, and
  `secretEnv` may not be anything in `FORBIDDEN_SECRET_ENV` or start `CLAUDE_`.

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
- **A review of a connector's tools can only DISABLE.** A name in
  `config.disabledTools` is a deny placed before `classifyRisk` in both gate
  rings; nothing in the product allows a tool by name, and `allowedTools`
  stays `[]` (§2, "Connector catalog, credentials and tool disable").
- **The irreversible acts added since are each a person's.** Sending a
  LinkedIn message is a person pressing Start and then "I sent it" (§2, "The
  LinkedIn provider is a person"). A share link is not a send: a person pastes
  the URL into a message they write, and a link can only be minted from a
  proposal a person already marked `sent`. Erasing a contact is owner-only and
  needs the contact's id typed back. Every SMS is drafted for one person from
  a registered template and approved by a person on `/approvals`.

---

## 2. Layout

```
apps/
  web/          Next.js 16 App Router — UI + BFF routes + Auth.js + two Vercel crons
  agent/        the long-running worker: agent turns, the send tick, IMAP, recovery
  voice/        inbound voice over Twilio ConversationRelay (Phase 6, not switched on)
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
  scratch, and its credential goes in an environment variable (`MCP_SECRET`
  unless the config names another) rather than on a command line, which is
  visible in `ps` to anyone on the host.

  **"Built from scratch" was true of the object `buildConnector` emits and
  not of the process, and a research pass found it.** The installed CLI
  spawns a stdio server with `{ ...its own env, CLAUDE_PROJECT_DIR, …,
  ...server.env }`, and its own env is `childEnv()` — which on the API-key
  path carries `ANTHROPIC_API_KEY` and `ANTHROPIC_CUSTOM_HEADERS`. Every stdio
  connector received the agency's key. `buildConnector` now launches each one
  as `/usr/bin/env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN
  -u ANTHROPIC_CUSTOM_HEADERS -u CLAUDE_CODE_OAUTH_TOKEN -- <command> <args>`
  (`SCRUBBED_FROM_STDIO`, `STDIO_LAUNCHER`); `env` execs the real command, so
  its argv is unchanged. The test spawns a real child the way the CLI does,
  with a control proving the bare command WOULD get the key, and fails if
  `childEnv()` ever emits a name nobody has classified. A command containing
  `=` (which `env` would read as an assignment) and a `config.env` that sets a
  scrubbed name are two new skip reasons.
- **the network the worker runs in.** `isReachableConnectorUrl` refuses the
  same hosts the scanner does, for a worse reason: the worker would send the
  connector's CREDENTIAL to whatever answered `169.254.169.254`. Re-checked at
  BUILD time, not only when the row was written.
- **the log.** Names and transports only. A URL carries a token in a query
  string sooner or later, whatever the form says.

**The argv leak is fixed: connectors go over stdin, never the command line.**
`sdk.mjs` turns every server in `options.mcpServers` that is not in-process
into `--mcp-config <json>` on the `claude` process's argv — the decrypted
`authorization`/`x-api-key` header and the stdio credential included, for as
long as a turn ran, readable by anyone who could list processes on the worker
host. Now `options.mcpServers` carries only the in-process `agency` server
(`buildQueryOptions` types it `McpSdkServerConfigWithInstance`), and the
connectors are handed over by `Query.setMcpServers` — an `mcp_set_servers`
`control_request` on the child's stdin — before the user's message is
(`apps/agent/src/runtime/open-query.ts`, shared by a turn and Test
connection). `agency` rides in that payload too, because `mcp_set_servers`
is AUTHORITATIVE: measured against CLI 2.1.269, leaving it out answers
`removed: ['agency']`. The hand-over waits for each server to connect or
fail, bounded by the CLI's own MCP timeout (30 s) and a 45 s cap of ours
(`HANDOVER_TIMEOUT_MS`), because a turn must always end.
`apps/agent/test/connector-argv.test.ts` runs the real SDK against a stub CLI
that records its argv and stdin, with a control showing the old shape DID put
the credential on argv. A stdio connector's credential still reaches its own
child through that child's environment, as above. **The product copy says
the same now** (both lines went on describing the old shape until a
follow-up corrected them): the catalog's "Where a credential goes" note in
`apps/web/src/components/settings/connector-catalog.tsx` says the worker
hands the credential to the claude process "over its control channel —
never on a command line", and that a server on the worker host receives it
in an environment variable, which that host shows to its own user and to
root; `STDIO_CAVEAT` in `packages/core/src/connector-catalog.ts` says a stdio
server is launched with the model credentials removed from its environment,
and the rest of the CLI's environment still reaches it.

### Connector catalog, credentials and tool disable

**Settings → Connectors → "Add from the catalog"** shows the presets in
`packages/core/src/connector-catalog.ts` (34, from the verified catalog only)
in four groups: *works today* (a Bearer token, or no credential at all, like
DeepWiki and Cloudflare's docs), *named header* (Hunter and Apollo
`x-api-key`, Close `close-api-key` plus a non-secret `close-scope`, Pipedrive
`x-api-token`, Sentry's `Sentry-Bearer` scheme), *runs on the worker host*
(four stdio servers) and *needs a connect flow — not built* (seven OAuth-only
servers, listed with a docs link and no Install button; OAuth is its own
piece of work, flagged here under §13). Install posts the preset to the
existing `POST /api/connectors` — no new route — and the connector is created
DISABLED; Test and Enable happen in place.

**A stdio preset is one click only when its package is pinned to an exact
version** (`npx pkg@1.2.3`, `uvx pkg==1.2.3`). None of the four is pinned
today, so each fills in the manual form for an owner to name the version they
reviewed. Pinning one in the catalog turns its Install button on with no web
change. The catalog's own versions were not looked up and written in, because
a version nobody verified is a claim in a file whose rule is "only claims that
were checked".

**Why a NAME is not a credential.** `secretHeader`, `secretPrefix` and
`secretEnv` say WHERE the worker puts the decrypted secret, never what it is;
`refuseCredentialShapedKeys` refuses a `headers`/`env` entry under the slot's
own name, a credential-shaped key, or a credential-shaped value (documented
prefixes like `sk-`, `ghp_`, `xox*`, `whsec_`, and hand-typed `Bearer`/`Basic`
schemes — `SENSITIVE_VALUE` alone would not have caught `sk-ant-…`). A tool
name may not contain `__`. `POST /api/connectors` now answers the
`connectors_name_is_not_agency` CHECK with a 409 sentence, keeps the
duplicate-name 409, answers 500 for anything else (before, every failure read
as a duplicate name), and deletes the credential it stored a moment earlier
when the insert fails. A connector named `agency` from BEFORE 0018 cannot be
updated at all: the CHECK was added `NOT VALID`, which spares existing rows
only at the moment it is added, and a CHECK is evaluated on every later
UPDATE of a row. So the enable/disable, `disabledTools`, credential and
probe routes answer it with a 409, `LEGACY_AGENCY_CONNECTOR_MESSAGE` ("…
delete it and add it again under another name"), where each answered a 500;
DELETE works. 0018's own comment ("never fails on an existing one") still
reads as if such a row were untouched; it is not edited, because 0018 has
shipped.

**Settings → Credentials exists** (the connector DELETE route already pointed
at it). It lists stored credentials — label, date, key version, the connectors
using each, or *orphaned* — deletes orphans only, and re-enters a connector's
credential. Re-entering disables the connector until it is tested again, and
deletes the old row unless another connector still holds it. It is the only
place a credential can be added to an existing connector. Without
`SECRETS_KEY` it refuses, 503, like the connector form.

**A per-tool review that can only DISABLE.** A name in `config.disabledTools`
is refused in both gate rings (`canUseTool` and `PreToolUse`) before
`classifyRisk` — no card, no approval row — and nothing here allows anything;
`allowedTools` stays `[]`. A catalog server nobody has reviewed carries the
catalog's `sendTools` as its default, DERIVED from the row's endpoint every
turn (so a hand-typed Zapier URL is still Zapier), and `'*'` crosses to the
gate as `mcp__<name>__*`, which no real tool name can collide with. An EMPTY
saved list is an owner's decision and overrides the default. The deny sentence
says the tool "is disabled in Settings → Connectors", not that an owner did
it: a catalog default was chosen by nobody, and the model repeats the sentence
to people.

**The panel stores the CLI's spelling of a tool name.** The CLI names an MCP
tool `mcp__<server>__<tool>` with each part passed through
`replace(/[^a-zA-Z0-9_-]/g, '_')` (read from the shipped binary), so a probe's
`github.create_issue` is stored as `github_create_issue`. A name that still
cannot be stored — one with a double underscore — is listed without a checkbox
and keeps asking a person.

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
tests.) The probe now hands its server over with `setMcpServers`, as a turn
does, and that reply waits for the connection, so its first status is
normally final; the poll stays for the case where it is not. It also runs
the binary a turn runs (`CLAUDE_CODE_PATH`), where before it found `claude`
on PATH and could test a different CLI from the one chat used.

### packages/tools
The tools as PLAIN DATA, with **no import of the Agent SDK anywhere in the
package**. `apps/agent/src/mcp/agency.ts` is the only file that adapts them to
`createSdkMcpServer`, and it is about thirty lines.

That split is not style. The SDK ships no mock transport and no
recorded-session mode, so anything needing the SDK to be *defined* is also
untestable — and a package that CANNOT import the SDK cannot drag it into the
Next module graph, which CI builds with no secrets on purpose.

Forty-nine tools ship (`AGENCY_TOOL_NAMES`). Twenty-six are low risk:
`get_icp`, `search_companies`, `get_company`, `scan_company`, `score_company`,
`get_pipeline`, `check_send`, `get_consent`, `get_replies`, `get_scan_history`,
`get_evidence_changes`, `get_stale_companies`, `get_pipeline_metrics`,
`get_company_timeline`, `get_compliance_summary`, `search_crm`, `list_tasks`,
and since 2026-10-06 `list_contacts`, `list_campaigns`, `list_drafts`,
`get_proposal`, `list_meetings`, `worker_status`, `recent_errors`,
`queue_status` and `rescan_stale`. Twenty are medium — they write internal
state, never anything outbound, and their summaries say nothing was sent:
`update_deal`, `book_meeting`, `classify_reply`, `add_note`, `create_task`,
and the operator's fifteen (below). Three are high: `queue_touch`,
`enrol_contacts` — the other tool that drafts for somebody outside the
company — and `resume_contact`, which lets campaigns write to a person again.
The registry pins both directions (`packages/core/test/risk.test.ts`): the
only `leaves_the_building` tools are `queue_touch` and `enrol_contacts`, both
high, and no write but the three scans is low.
`get_pipeline` and `update_deal` arrived with Phase 5, once `deals` was a
table something writes — before that a tool that reliably returned `[]` would
have taught the model a false shape of the business. `draft_outreach` is the
one §6 tool that does not exist by that name: a draft is `queue_touch` parked
on a human, which is Phase 4's single send path.

The fourteen added with 0018, one line each:

- **`check_send` and `get_consent`** make the gate's rule visible to the
  model; both queue nothing. `get_consent` reports a suppression match by kind
  and recording path, never the value. `check_send`'s data carries the
  consent row AS RECORDED, as `get_consent` reads it, and `pausedFor`, the
  pause's class. When the send path's own `paused` code is the reason, the
  summary leads with words for that class (`pauseReasonClass`, the inbox's
  exact reading): only `replied` — exactly `replied <ISO instant>` —
  promises an /inbox answer (unless `sharedNumberHold` holds, below) and is
  called "not a refusal of <channel>";
  `manual` says answering a reply does not lift it; `unsubscribed` is their
  opt-out; `opt_out_not_recorded` and `erasure` say to record the opt-out or
  finish the erasure, and never to resume them — except a shared number's
  holder (`isSharedNumberOptOutPause`), worded as a holder: a text from a
  number they share asked to stop, it may not have been them, and a person
  records the number on /suppressions before the pause can be lifted. And a
  holder whose OWN pause stood (review round 10): when `facts.sharedNumberHold`
  — previewSend's fact — holds, the paused summary (`pauseWords`) and the
  other-refusal branch append "They also hold a phone number a text came
  from that asked to stop, and it could not be recorded — it may not have
  been them — so Resume is refused until a person records the number on
  /suppressions; do not suggest resuming them before that.", and its data
  carries `facts.sharedNumberHold`; before, a teammate's pause there read
  "until a person resumes them on /contacts", which Resume refused. For a
  `replied` pause, whose /inbox answer `replyQueueDraft` refuses then too,
  the summary drops that promise and appends `SHARED_NUMBER_HOLD_REPLIED_WORDS`
  instead — "…so neither answering their reply from /inbox nor Resume on
  /contacts lifts the pause until a person records the number on
  /suppressions; do not suggest either before that." — in both branches
  (review round 13).
  `get_consent`'s first line for such a person reads "paused: nothing is
  sent to them, and they cannot be resumed until a person records a phone
  number they share on /suppressions — a text from it asked to stop and
  could not be recorded, and it may not have been them" in place of "until
  a person resumes them", and its data carries `sharedNumberHold` (from
  `consentLedgerFor`). One
  hold round 8 added is not told apart here yet, stated: a contact a
  colleague's unrecorded stop was filed under reads as an ordinary `replied`
  pause (§2, "The opt-out reader runs first"). A prefix test used to call a
  teammate's "replied on the phone (by …)" a reply pause, promising an
  answer the inbox then refused. A suppression or a recorded refusal
  outranks the pause and is reported as itself, with the pause beside it.
- **`get_scan_history`** lists every scan newest first with the score whose
  `scan_id` names it; an unreachable scan is "unreachable", never a 0.
- **`get_evidence_changes`** compares the two newest scans that reached the
  site through `diffFindings`; not-assessed is never "fixed", a signal whose
  subject went away is "no longer applicable", never fixed, and
  informational signals are reported apart, as context.
- **`get_stale_companies`** lists stale, unreachable and never-scanned
  companies, judged by `isStale` on `ran_at` and never by `findings.stale`.
- **`get_replies`** reads `inboxTouches` newest first and shows a reply's
  first line only — at most 200 characters, labelled as the sender's own
  words, never the address.
- **`classify_reply`** records a kind through `replyReclassify` (actor
  `agent`) or marks a reply handled by the principal through
  `replyMarkHandled`. It can never name `opted_out`: the enum has no such
  value, a row that is `opted_out` is refused whatever kind is asked, and
  `replyReclassify`'s own predicate refuses both again. `replyReclassify`
  also refuses a reply from a suppressed person (`suppressed`) and an
  unclassified one that `looksLikeOptOut` (`reads_as_opt_out`). Moving a reply
  off `auto_reply` to a human kind pauses the contact (`replied <reply
  instant>`) and cancels their queued, awaiting-approval and approved
  messages — what `recordInboundReply` skipped for it — and does not move the
  deal.
- **`get_pipeline_metrics`** is `pipelineMetrics` over `listDeals` and
  `analyticsTransitions`, windowed: moves recorded in `sinceDays`, and deals
  open now or closed inside it. Below five it prints "insufficient data".
- **`get_company_timeline`** merges touches, scans with THAT scan's score,
  deal audit rows, meetings, proposals, calls, notes and tasks, newest first.
  A message is its subject and first line, except a LinkedIn message
  `linkedinThreadWithheld` names, which prints only `<channel> message out,
  <status> — words withheld (<why>)` (review round 5: a person could
  otherwise copy them from a chat into LinkedIn past every rule Start
  runs), and then the summary adds "A LinkedIn message’s words are shown
  only where /tasks would show them — Start checks every send rule first."
  A note is `note by <name>: "…"`,
  and the summary says a note is a teammate's words, not evidence. A meeting
  is printed in its own zone with the UTC instant beside it.
- **`get_compliance_summary`** is `complianceSummary` at the ICP's stale
  window — counts only, gated on `audit:read` like the page.
- **`search_crm`** is `searchOrg` with `searchSectionsFor(principal)`
  intersected with the sections asked for, never wider; the query is not
  audited. An empty `sections` list means all of them (it used to search
  nothing and answer "cannot read ."), and `not_permitted` is answered only
  when something asked for was refused and nothing was searched.
- **`add_note`** (`companies:write`), **`create_task`** (`deals:write`, kind
  `todo`, the assignee resolved in THIS org and not revoked) and
  **`list_tasks`** (`deals:read`; `open: false` includes done ones). Neither
  write is filed as if a person made it, because any teammate may approve the
  card: an agent's task has `created_by` NULL and its `task.created` row the
  actor `agent`. A note must name a person (`author_user_id` is NOT NULL), so
  it is stored in the name of the person whose chat it is, and its
  `note.added` row carries actor `agent` with `detail.authorUserId` naming
  them — `/audit` reads "wrote a note on X in the name of <name>; it shows as
  theirs". The note row carries no mark (`notes` has no column for one), so
  the company page and `get_company_timeline` still show `note by <owner>`;
  the system prompt tells the model so.

Each asks `can()` the question its page or route asks, which only matters for
a role `can()` does not know — that role gets `not_permitted`. **Only the tool
summary reaches the model (§5.5)**: a reply's words appear there only as a
bounded first line, never the body or the reply's own subject, and no audit
detail carries any of its text.

### The operator's tools (2026-10-06)

**Chat carries out what it is asked.** Twenty-six tools in four files, each a
thin layer over the function the web route for the same act calls, after the
same checks, so the agent's write and a person's are the same row refused for
the same reasons in the same words; where the route writes its own audit row,
the tool writes it too with actor `agent`, beside its own `agent.<tool>` row
(ids, counts, flags, fixed words). The system prompt says how to work — read,
act, confirm, report — and names every one with its limit (§8).

**Only the summary reaches the model.** `apps/agent/src/mcp/agency.ts` returns
`outcome.summary` and never `data`, so an id the model needs for a later call
is PRINTED: a contact's, a campaign's, a meeting's, a proposal's, and — since
this change — a task's in `list_tasks`, which `complete_task` names. Review
round 16 found five more an act needed and no read printed, and prints them:
`book_meeting`'s meeting, `create_task`'s task, the deal in `get_pipeline`
and `update_deal`, and every `search_crm` match (`· id <uuid>`), which the
contact tools' `contactId` already claimed it gave; and `list_meetings`
reaches a year ahead, where it stopped at 60 days. An address is not:
`list_contacts` masks an email to `…@domain`, and so does `search_crm` for a
contact now (a number-only label is withheld), though it still finds them by
the whole address; a pause is shown by its class (`pauseReasonClass`) and
time, never its reason.

- **`records.ts`** — `list_contacts` (`contacts:read`, what `/contacts`
  reads: consent per channel as recorded, suppression standing, the pause's
  class, the bounce). `add_company` and `import_companies` (50 at most) add
  through `importCompanies` with source `agent`, only a host the scanner
  would request (`isScannableHost` — the importer's own check passes
  `169.254.169.254`) and never an `.inbound` placeholder; neither scans.
  `update_company` is `companiesUpdate`. `add_contact` is `createContact` and
  records no consent. `update_contact` is `contactsUpdate` with every refusal
  it words, plus one rule of the agent's own: no email, phone or LinkedIn
  change while a message to the person is awaiting approval, approved, queued
  or sending, because the sender reads the address at the moment it sends.
  `pause_contact` is `contactPauseByHand` with `<why> (by the agent, for <the
  chat owner>)`, a teammate's hold (`manual`), and refuses a reason that
  opens "opt-out not recorded", which nobody could lift. `resume_contact`
  (high) takes the `pausedFor` class the model read, refuses when the pause
  is now of another class, and hands `contactResumeByHand` the CURRENT
  reason, so every refusal Resume has — the shared number's, the kept
  holder's, an own unrecorded opt-out, an erasure, a colleague's stop — is
  worded as `/contacts` words it. `add_suppression` is `addSuppression`,
  source `manual` (a person approved it), with the route's
  `suppression.added` row; its summary never echoes the value. Since review
  round 16 it takes a `contactId` and records that person's OWN email, phone
  or LinkedIn key as stored, never a domain from one person: the model sees
  addresses by their domain only, so a value it typed for "Jo asked us to
  stop" was a guess — recorded, reported as the opt-out, while Jo stayed
  sendable. A typed `value` is still taken, and its summary says how many
  contacts on file the key covers ("It matches no contact on file …").
- **`campaigns.ts`** — `list_campaigns` (`campaigns:read`); `create_campaign`
  makes a SUPERVISED email or LinkedIn campaign — no auto-send input, the
  form's defaults; `update_campaign` passes the status and auto-send it read
  (`expectStatus`) — and, setting a campaign active, the status the MODEL
  read (`statusRead`, required; review round 16), because the card can wait
  half an hour and a teammate's pause in that time must stand, where the
  handler's own read after approval undid it — changes neither channel nor
  auto-send, may only PAUSE an
  auto-send campaign, and never sets active a campaign the worker paused for
  bouncing; `enrol_contacts` (high) is `enrolCampaign` on a supervised
  campaign only, its drafts `awaiting_approval`, and says so if an owner
  switched auto-send on during the call — at most 50 a call, and it stops
  drafting at 20 s (`enrolCampaign`'s `stopWhen`, `outOfTime`), because the
  MCP call is cut off at 30 s while the handler drafted on, so the model said
  enrolment failed while drafts landed, and a retry could draft twice the
  approved number (review round 16); enrolling again continues, as past the
  limit; `list_drafts` (`approvals:decide`)
  is `/approvals` read four previews at a time, the recipient masked, a
  LinkedIn message's words withheld by `linkedinThreadWithheld`, an SMS
  named by its DLT template id.
- **`proposals.ts`** — `generate_proposal` (`deals:write`, `created_by` NULL
  as an agent's task) refuses as the company page's Generate button does;
  `get_proposal` says whether the evidence is current, stale or superseded;
  `list_meetings` prints each in its own zone with UTC; `reschedule_meeting`
  takes an instant with its offset on a date that exists — and, as
  `rescheduleMeeting` does, only for a meeting that has started (a future one
  is cancelled and booked again); `cancel_meeting` and
  `record_meeting_outcome` (`held`, `no_show`) refuse as the route does;
  `set_deal_owner` refuses a revoked teammate; `complete_task` closes a task
  in the chat owner's name and never a `linkedin_send` step.
- **`ops.ts`, in place of a terminal** — `worker_status`, `recent_errors`
  and `queue_status` (`chat:use`) and `rescan_stale` (`companies:write`).
  `ToolContext.ops` is optional (`OpsContext`, built by `startWorker` from
  `healthInputs()`, `apps/agent/src/ops/context.ts`); without it each tool
  answers from the database and says the worker's own view is not here.
  `recent_errors` reads a ring of the worker's last 200 kinds of warn and
  error line (`apps/agent/src/ops/recent-log.ts`) that keeps the message
  literal, the level, a count, first and last seen and an error class or code
  on an allow-list — never another field, because field values carry ids,
  hosts and reasons. `queue_status` counts outbound rows by status and
  channel, deferred apart from due, refusals and failures in the last day,
  pending approvals, open LinkedIn steps, and a channel the worker carries no
  provider for. `rescan_stale` picks at most three stale or never-scanned
  companies through `rescanQueue` (never `.inbound`; a refused host takes no
  slot), scans them through `scan_company`'s own writer at the cron's
  timeouts, raced against 25 s (`TOOL_TIME_BUDGET_MS`, inside the MCP call's
  30), and reports a scan still running rather than waiting for it — one
  that records itself only if it finishes inside its worst case (162 s), and
  is abandoned unrecorded after. A site stays taken until its REQUEST ends,
  not when the race is lost (review round 16: abandoning closes nothing, and
  the next call started a second request beside the first), and an
  abandoned or failed scan is counted as `abandoned` or `failed`, never as
  `unreachable`, which claims a recorded scan.

**`book_meeting` recorded a day nobody typed**, found while these were
written: V8 rolls `2026-02-30` to 2 March, and its own pattern let the string
through. `instantFrom` (`packages/tools/src/instant.ts`) is now the one
reading for both meeting tools, refusing an impossible date, hour 24 and an
instant with no offset. **And two routes the tools sit beside were fixed:**
`POST /api/contacts` stored a phone as typed — `createContact` stores E.164
now, or refuses in the edit's words (`phoneNotInternational`), because a
number in any other form matches no suppression key and no text sent back —
and stored a LinkedIn URL no profile could be read from, which the route now
refuses first (`linkedinIsReadable`); and the campaign routes answer only a
unique violation as "already exists" (409), where `PATCH` answered a rename
onto a taken name with a 500 and `POST` called every fault a duplicate.

**Stated residuals.** `resume_contact` matches a pause by its CLASS, so a
different pause of the same class written while the card waited is the one
lifted — the approver approved lifting that class for that person.
`rescan_stale` reads the nightly rescan's claim and takes none, because a
claim would make that night's run skip the org; a cron starting while one of
its scans is still running — up to that scan's 162 s worst case, well past
the call's answer at 25 s — can scan the same company once more. It reads a
claim as released once the run has written its `scan.cron_run` row (compared
in SQL against the claim's stored `created_at`), where the claim's `until`
alone, its whole five-minute budget, said the rescan "is running now" for
minutes after it ended (review round 16); `claimRescan` keeps the plain
reading. `queue_status`'s "last 24 hours" counts messages that last CHANGED
then, and says so: no column records the moment of a refusal, and any later
UPDATE — deleting the contact, say — counts an old one again. A web `PATCH` that clears a
bounce still records `contact.bounce_cleared` as System (`contactsUpdate`'s
default actor). And `recent_errors` does not see a line written straight to
stderr — the entry point's "failed to start", or the recorder lines the
inbox forwards.

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

### Informational signals

**Thirteen additive keys, read from bytes already captured** — no new request
class (`ADDITIVE_SIGNAL_KEYS`): `csp_report_only`, `csp_quality`,
`cookie_flags`, `referrer_policy_quality`, `permissions_policy_quality`,
`content_type_options_quality`, `cross_origin_policies`, `sri_third_party`,
`mixed_content`, `stack_disclosure`, `deprecated_headers`, `hsts_quality`,
`reporting_endpoints`. They are posture CONTEXT from the homepage response,
stored as findings with `scored = false` and weight 0 (§1), shown in their own
section of the company page, and returned by `get_company` — observed ones
only, each labelled. **Promotion is a data change:** add the key to the ICP
with a weight. `weight: 0` in an ICP is refused. A proposal then refuses
`rescore` from a scan recorded before the promotion, until the company is
re-scanned (§2, "The pipeline").

Parity's guarantee moved from "no extra keys" to "no unexpected keys", and the
parity ICP is frozen in `packages/scanner/test/icp-parity.json` so an ICP edit
cannot move the goldens. `cookie_flags` reads `home.setCookies` and
`csp_quality` reads `home.cspHeaders`, both optional on the capture and
neither held by the sixteen recorded fixtures, so there `cookie_flags` reads
"not captured" and `csp_quality` falls back to the one policy the header map
keeps — no fixture was re-recorded and no golden changed; a re-record ships
alone, with its diff read (§5).

The words are honest in both directions. "No cookies" reads *not applicable*,
never as a pass. An `http://` `<link rel=canonical>` is a pointer, not a load,
so only stylesheet/preload/modulepreload links count as blockable mixed
content, and a `<noscript>` reference is left out. A short documented list of
tag-manager hosts is counted in the SRI ratio and never flagged, because an
SRI-less tag manager is a ratio, not a gap. `csp_quality` is UNOBSERVED —
"several Content-Security-Policy headers were sent; this check reads one
policy at a time" — when more than one non-blank enforced policy was sent,
because the effective policy is their intersection and reading the first
alone called a site's scripts unrestricted when its `script-src` sat in the
second. `stack_disclosure` no longer flags every `Via`: each hop is judged
with `VERSIONED_SERVER` after its protocol token, which every intermediary
must add, so `1.1 google` is clear and `1.1 varnish (Varnish/6.0)` is a gap.
"Not applicable" is its own status wherever a finding is read back — the
diff, `readingWords` (an informational side is "observed" or "not
applicable", never "in place") and the findings CSV, whose `gap` column says
`not applicable` rather than `no` — all through one `isNotApplicable`.
`recordScan`'s observed and unobserved counts are over scored signals only;
`informationalCount` counts the rest.

### Evidence: history, the diff and the timeline

**A diff never turns a blocked fetch into a fix.** `diffFindings` calls a
signal `unchanged` only when BOTH scans observed it; a signal neither saw is
`not_assessed_this_time`, and one scan's failure to observe is never a change
in either direction. It reads a fourth state too, NOT APPLICABLE
(`isNotApplicable` in `packages/core/src/informational.ts`, shared with
`informationalStatus` and the findings CSV): a gap or clear becoming n/a is
`no_longer_applicable`, n/a becoming a gap or clear is `now_applicable`, and
n/a twice is `unchanged`. Both are counted apart
(`summary.noLongerApplicable`, `summary.nowApplicable`) and never in `fixed`
or `regressed`, because a CSP with `'unsafe-inline'` that was later removed
read as "fixed" — nothing was fixed; the thing being judged was gone.
`SIGNAL_CHANGES` lists every kind a renderer must have words for.
`scanHistory` joins the score on `scan_id` (the newest
score for that scan, by a lateral join — `scores` has no unique `scan_id`) and
reports `score: null` for every `ok: false` scan, although `recordScan` stores
a 0 with `unreachable (…)` for one: a timeout is never charted as a 0.

**The company page shows history, the diff and a timeline.** The timeline
reads deal moves from deal rows AND from the labels inside `contact.replied`,
`meeting.booked` and `proposal.accepted(_via_share)` — `setDealStage` writes
no row for a won — and folds a companion into the first-class row it repeats
within 60 seconds; two first-class rows are never folded. It is cut at
`completeSince()`, the latest oldest-row among the sources that hit their
read limit, and says so, rather than showing a truncated source's gap as a
quiet stretch. Every panel dates evidence from `scans.ran_at` through
`isStale`, never from `findings.stale`.

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
| 0018 release ✅ | the informational signals' words, `diffFindings`, rotting and `pipelineMetrics`, enrolment's gate and draft, the kickoff and renewal templates, the bounce and auto-reply readers, the connector catalog as data, suppression sources; from review, the one stale-threshold reader (`staleAfterDaysOf`) and the pause as its own refusal, with its class and words (`pauseReasonClass`, `pausedSentence`, re-exported by `packages/db`'s inbox); from later review, `htmlToText` (`html-text.ts`, linear time, the one converter both inbound paths use) and the opt-out alarm's Slack payload (`slack-payload.ts`, so the web and the worker post identical bytes) |
| 0019 release ✅ | DLT (`dlt.ts`): `parseTemplate`, `renderTemplate`, `matchesTemplate` (both judging links and call-back numbers on the rendered text, `smuggledRuns`), `DLT_VAR_MAX_CHARS` (30 code points), TRAI's `PROMOTIONAL_WINDOW` (10:00–21:00 IST, and `hours` for the recipient's own clock), `promotionalBand` (`{ open, india, opensToday, nextOpen }`), `insidePromotionalBand`, `nextOpenMinute` and `isIndianNumber`, `smsOptOut` (the whole message, since review round 6 clause by clause, since review round 7 a capital STOP ending the text, and since review round 8 not after NON, FULL, a possessive or a place word, not STOP BY/IN/OVER/OFF, nor a bare STOP ending a question), `parseTemplateCategory`, `normaliseDltHeader`; `TEMPLATE_CHANNELS`, `TemplateFacts` and the two template steps in `decideSend`, and the promotional band's two (a band that never opens, `band_never_opens`; a band not open now); from review, `SendRefusal.retryAt` and `deferUntil` with its three bounds (`DEFER_FALLBACK_MS`, `DEFER_MAX_MS`, `DEFER_SLOW_MS`) in `send.ts` |

---

### The send path (Phase 4, §8.4)

**One function decides; one function sends; nothing else may.** `decideSend`
in `packages/core` is pure — facts in, decision out — and it is the ONLY
place §2.1's rules live. A caller cannot reorder the checks because it does
not perform them, and cannot skip one because the facts for all of them are
required arguments: a caller that forgot the suppression lookup cannot call
the function at all. `dispatchTouch` in `packages/db` is the only function
that reaches a provider, and both an auto-send message and a human-approved
draft go through it. The order is §8.4's, with the steps it does not name
put where they belong — cold channel → unparseable recipient → suppressed →
consent (`no_consent`, `consent_revoked`) → **paused → stale evidence →
bounced** → **no template → template mismatch** (SMS and WhatsApp only,
0019) → zone → a promotional SMS whose band never opens
(`band_never_opens`, below) → the campaign's quiet hours → the promotional
band (also `quiet_hours`) → daily cap → campaign inactive → approval — and
`packages/core/test/send.test.ts` asserts the ORDER, not just the outcomes,
in two tables: every channel's, and SMS's with the template steps — the
refusal code is what somebody reads six months later. The
pause, stale evidence and the bounce sit after consent because none of them
is a person asking to be left alone, so none may outrank one in the log; the
pause comes right after consent. Stale evidence, which nobody may approve
past, comes before the bounce, which a person resolves, because a stale
draft whose address also bounced read as "fix this first" with Approve
enabled and turned into a blocked `stale_evidence` once the address was
corrected. The template steps come after every refusal about the PERSON,
because they are about the words — a suppressed or declined person must be
logged as that, never as a template fault. All five come before the clock,
because a message held until morning would still be to somebody paused,
would still quote something no longer known to be true, would still bounce,
and would still be scrubbed by the operator.

**A person approves the words, not the moment.** Approving a draft names the
recipient, the campaign and the approver (0011: a row may not say "approved"
without both, like `approvals`) and marks it `approved`. The approver
chooses the recipient on email and LinkedIn only: an SMS or WhatsApp draft
is a registered template filled in for ONE person, so `approveDraft`
refuses it to anyone but its own `contact_id` (`rendered_for_another`, §2,
"The approvals page"). The worker's tick
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

**Seven refusals nobody can approve past.** A suppression (somebody asking
to be left alone), a recorded refusal, cold voice/SMS/WhatsApp, and — added
by review — `stale_evidence` (§2.2): the words quote a scan that is past its
re-verification deadline at the moment of sending, or one a newer
successful scan has superseded (§1), and approving them does not make them
current; the fix is a re-scan and a new draft, or for a superseded scan a
new draft from the latest one. And `paused`:
a person held from every campaign — they replied, a teammate is holding
them, an opt-out or an erasure could not be completed, or a text from a
number they share asked to stop and could not be recorded — never lifted by
approving one message past the hold. Who may lift it depends on its class:
answering the reply from `/inbox` ends only a `replied` pause, and Resume on
`/contacts` refuses an `opt_out_not_recorded` or `erasure` pause outright
(409), even once the opt-out has been recorded by hand — except a shared
number's holder (`isSharedNumberOptOutPause`, review round 8), refused
`RESUME_SHARED_NUMBER` only until a phone suppression in their org matches
their phone, and then lifted (§2, "SMS through DoveSoft") — any pause at
all of a contact held for a shared number's unrecorded STOP, that hard hold
or a pause of their own the holders' loud path kept and a row listing them
(`heldForUnrecordedSharedNumber` in `sms.ts`, review round 9), while the
number on their phone has no phone suppression in their org, refused for a
kept pause `RESUME_SHARED_NUMBER_KEPT`, which does not say they asked (a
row listing them counts only until a `contact.resumed` row for them is
NEWER than it: review round 10, below) —
and any pause at all while the inbox's own `unrecordedOptOut` reading
holds: an opt-out of THEIRS while an address it was about has no
suppression row (`ownOptOutStillToRecord`, review round 9) — for a
`contact.opt_out_not_recorded` row the address the reply it names came
from and the contact's own address on the row's channel (every address
when it names none), for `unsubscribe.not_recorded` the address the
message was delivered to and the contact's email, for
`contact.erasure_failed` every address, and for an opted-out reply of
theirs its From — any key of an address recording it, so a domain row
still covers an email, and the sentence naming what to record by kind
("their email address", "the address their reply came from (shown on
/inbox)"), never by value (any key of their email, phone or LinkedIn
profile ended it before, so a number's suppression ended an email
opt-out, and the email went) — or (review round 8) an opted-out reply
from ANOTHER address on the thread filed under them whose own From no
suppression row matches, refused
`RESUME_UNRECORDED_ANOTHER_ADDRESS` in words that name the address to record
— the reply's — because a suppression on the contact's address satisfied
this gate and left the person who asked unrecorded (`contactResumeByHand`
in `packages/db/src/inbox.ts`) — the button used to resume whatever the
class, including the pauses that are the only protection left when an
opt-out could not be stored. A shared-number row stops governing a holder
once a `contact.resumed` row for them is newer than it (review round 10,
`sharedNumberHolderRow`, and so `sharedNumberHolderRowExists`, the stored
`created_at`s compared in SQL, never a `Date` read back): Resume lifts a
pause of a holder a governing row lists only once the number is recorded,
so a later resume is a person having lifted the hold, and read for ever
the row refused every later pause of theirs, a teammate's included, and
froze their phone once an owner removed the number's suppression. A newer
row lists them afresh. Every writer of `contact.resumed` asks the same
question first (review round 12): `/inbox`'s answer (`replyQueueDraft`)
refuses `opt_out_not_recorded` with `SHARED_NUMBER_HELD` — record the
number, then answer — and `dispatchTouch`'s recovered-send lift
(`liftRecoveryPause`) keeps the re-pause, both under the contact's lock,
because each lifted a listed holder's `replied` pause past the gate —
reachable through the `paused` shortfall or a Resume that landed before
the row committed — and its `contact.resumed` spent the row while the
number was still unrecorded. So `/contacts` Resume, the inbox's answer and
the recovery agree about such a holder. Both
resume paths lift only the pause they were asked about
(`resumeContact`'s `expectedReason`,
in the UPDATE's predicate): the inbox the pause it READ under its locks,
and `/contacts` the pause the PAGE SHOWED (review round 4). Every Resume
button — the ledger, the company page's People, `/suppressions`' paused
list and `/inbox` — sends the `pausedReason` it rendered, and
`contactResumeByHand(db, { orgId, contact, expectedReason, actor })` judges
it against the contact locked in its own transaction; the route used to
judge and lift the pause IT read after the click, so a teammate's hold
written after the page loaded was lifted from a stale tab. A shared
number's holder is offered Resume too (review round 9): `/contacts` decides
its buttons through `resumeOfferFor` in
`apps/web/src/lib/shared-number-pause.ts`, beside a client-safe copy of
`sms.ts`'s `isSharedNumberOptOutPause` that `shared-number-pause.test.ts`
holds equal to it, regex text included, and all four screens say beside
that Resume (`SharedNumberHolderNote`) "A text from a number they share
asked to stop, and it could not be recorded — they may not have sent it.
Record the number on /suppressions, then Resume; until the number is
recorded there, Resume is refused." The ledger read the pause's class
alone, said such a holder had asked to stop and offered no Resume, while
the route lifts it once the number is recorded; only the contact's own
unrecorded opt-out and an unfinished erasure show no Resume now. Since
review round 10 `resumeOfferFor` also takes the ledger row's
`sharedNumberHold` (from `consentLedgerFor`), so a holder whose OWN pause
stood (`holdHard`'s `kept`) — a teammate's or an unsubscribe's, which by
its shape alone got a plain Resume the route then refused
`RESUME_SHARED_NUMBER_KEPT` — gets `record_number` on `/contacts`, the
note beside Resume; and `/approvals`' paused block (`approveBlock`, through
`decisionView(decision, preview.facts)` and
`CandidateDecision.sharedNumberHold`) adds "A text from a number they share
asked to stop and could not be recorded — they may not have sent it — so
they cannot be resumed until the number is recorded on /suppressions."
**Stated residual:** `/suppressions`' paused list, `/inbox` and the company
page's People still decide the note by the pause's SHAPE alone
(`isSharedNumberOptOutPause`), so a kept holder reads a plain Resume there
with no note, and Resume's 409 (`RESUME_SHARED_NUMBER_KEPT`) is what says
what to do — giving them the fact would be one
`heldForUnrecordedSharedNumber` read per paused row on unbounded lists.
`/inbox`'s answer composer is the same (review round 14): for a listed
holder paused by their own reply it still offers Answer and says "Drafting
resumes <name>", and the draft's 409 (`SHARED_NUMBER_HELD`: record the
number, then answer) is what says what to do — nothing is drafted or sent.
And `/suppressions`' paused list opens "Held from every campaign — most
often because they replied; each row says why", where it read "A contact
who replied.", false of a holder who may have sent nothing; since review
round 10 it names every paused person ("(no name recorded)" otherwise)
beside their email, else their phone, else their id (`pausedContacts` in
`campaigns.ts` returns `firstName`, `lastName` and `phone`), and a shared
number's holder's row shows "The number they share: <phone>" under the
note, with, for `contacts:write`, a "Fill it in above" button that sets the
add form to kind phone with that value — it adds nothing itself. `/inbox`
shows "The number they share: <phone>" beside its note too, from
`inboxTouches`' contact projection, which carries `phone` now. A pause that
changed since is a 409 `changed_meanwhile` ("Reload the page …"), an
unpaused contact a 409 `not_paused`, a missing one a 404, and a body with no
`pausedReason` a 400; the guarded `resumeContact` also requires `paused_at
IS NOT NULL`. The `contact.resumed` row (`{ pausedFor }` only) is written
inside that transaction, uncaught, and no longer by the route — so a resume
with no row, or a row with no resume, cannot exist, which is what
`repauseForUnansweredReply` reads (below). `pausedSentence` words each
class, and never says "resume" for an opt-out nobody could record or an
erasure that did not finish; its `opt_out_not_recorded` sentence says "This
contact asked to stop — or a text from a number they share did —" since
review round 8, because a shared number's holders are paused in that class
and may have sent nothing. And 0019's two: `no_template` (an SMS or
WhatsApp message naming no registered template, or a deactivated one) and
`template_mismatch` (words that are not their template with each slot
filled) — an approval does not make the operator deliver words it did not
register, and the fix is a new draft from an active template. §2.1 says cold SMS must be "structurally
impossible"; an approver offered enough impossible things learns to click
yes.

**The clock is not a refusal.** Quiet hours, the cap and a paused campaign
DEFER a message (`scheduled_for`, same status, approver kept), and so does
the band for a promotional SMS — 10:00–21:00 where the recipient is, for
every number, and TRAI's 10:00–21:00 IST as well for a +91 one
(`promotionalBand`, `isIndianNumber`) — under the same `quiet_hours` code,
so the sender and `/approvals` needed no new one; everything
else is terminal, stale evidence included. **One band is not the clock**
(review round 4): a promotional SMS to a +91 number read in a zone whose
10:00–21:00 never meets IST's at today's clocks — Denver and Phoenix all
year, Los Angeles on daylight time — has no moment it may go, so it is
refused `band_never_opens` (terminal at the tick, `humanCanResolve: true`,
worded "promotional band never opens for them"), checked right after the
zone and before the campaign's quiet hours, with a sentence naming the zone
and both fixes: set `Asia/Kolkata` on the contact if they are in India, or
draft again from a service template. Deferring it re-queued the row every
hour for ever behind "it goes when the band opens", and the words would
have been months old if it ever went. Round 4 reused `unknown_timezone`,
which every screen words "no timezone on the contact" — false of a contact
whose zone is Denver — so review round 5 gave it a code of its own, listed
in `REFUSALS_A_CORRECTION_RESOLVES` and
`COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE`; a zone fixed before the draft is
sent makes the same draft sendable. The same code refuses a band that opens
only inside the campaign's own quiet hours, so that no minute of the day is
open to both — which would otherwise be deferred an hour at a time for ever
too — and that sentence names the window and says to narrow it. "Today" is
the UTC offsets in force at the moment of sending,
because a daylight-saving change opens or closes the overlap. The default window wraps
midnight, and the naive comparison is not merely wrong for 21:00–08:00, it is
inverted.

**A deferral names the minute it may go** (review round 5). A `quiet_hours`
refusal carries `retryAt`: the first whole minute after now that is outside
the campaign's quiet hours and, for a promotional SMS, inside the band,
read at the UTC offsets in force at now (`nextOpenMinute`, which asks each
of the next 1,440 minutes). `deferUntil(decision, now)` in
`packages/core/src/send.ts` is what the worker's tick and LinkedIn's Start
both put in `scheduled_for`, so the two cannot land in different places:
`retryAt` when it is ahead of now, capped at 24 hours (`DEFER_MAX_MS`); an
hour (`DEFER_FALLBACK_MS`) when it is missing or not ahead; six hours
(`DEFER_SLOW_MS`) for the cap and a paused campaign; and null — terminal —
for every other code. It was a flat hour, and a band half an hour wide (an
Indian number read in New York or Los Angeles in winter, or in Chicago in
summer) was stepped over by every retry whose minute past the hour fell
outside it, for up to ten days. A daylight-saving change between the
deferral and the retry can make the message late by the size of the change
or defer it once more, never early, because whoever waits asks every rule
again. `decisionView` leaves `retryAt` out of what reaches `/approvals`.

**Every outbound message carries a campaign**, because the campaign is where
the cap and the quiet hours live. Companies and contacts carry an IANA
`time_zone` (0010) — never derived from `companies.country`, which is not a
timezone (the US has six).

**A message is checked on its OWN channel, not its campaign's** (review
round 3). `sendFactsFor` used to take the channel from the campaign, and
with it the recipient, the suppression keys, consent and the bounce, while
`dispatchTouch` picked the provider by the row's channel — so a campaign
switched from LinkedIn to email while it held approved messages handed a
LinkedIn message to somebody suppressed on LinkedIn, checked against their
email keys. Now `gatherFacts` passes `touch.channel`, `previewSend` reads the
channel off the stored row its `writtenAt` names, and only words nobody has
stored take the campaign's. A message whose campaign now sends on another
channel has no campaign of its own: it is refused terminally through the
missing-facts path — `refusal_code` `unparseable_recipient`, which a
correction resolves, with the sentence in `touches.error` — unless a refusal
nobody may approve past, judged on the words' own channel, outranks it
(`channelMismatch`, exported for `previewSend`), so a LinkedIn-suppressed
person is recorded `suppressed`. And the edit that would strand such a
message is refused: `updateCampaign` will not change a campaign's channel
while it has queued, awaiting-approval, approved or sending rows (409
`channel_has_live_messages`).

**A campaign edit is made over what the form loaded.** The form sends every
field back, status included, so a teammate who changed only the cap
re-activated a campaign the worker had paused for bouncing in between. The
form now sends the status it loaded (`expectStatus`), and `updateCampaign`
puts it in the UPDATE's predicate beside the auto-send expectation; a save
that matches nothing reads the row again and names the first expectation
that failed — `status_changed` ("This campaign was set to paused while you
were editing … Nothing was saved"), `auto_send_changed`,
`channel_has_live_messages`, or `changed` — as a `CampaignUpdate` union the
route words as a 409.

**A reply does four things in one call** (`recordInboundReply`): logs the
inbound touch, pauses the contact (one UPDATE, every campaign, immediately),
cancels what was queued for them, and moves the deal FORWARD to `replied` —
forward only, so a late reply never knocks a booked meeting back. If it
says stop in so many words, the address goes on the suppression list: the
reply IS the opt-out — on SMS and WhatsApp the number, read by `smsOptOut`
(STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT and OPT OUT alone; a stop
word, `unsub` included, and one token, with an optional `all` before the
token — `STOP ALL 56161`, `UNSUBSCRIBE ALL ACMEIN` — and a comma, colon or
dash allowed after the keyword; "reply STOP"; a few SMS sentences, and the
email reader's whole-message forms restated behind an optional
please/pls/plz/kindly and before any run of please, pls, plz, thanks, thank
you or thx set off by a space, a comma or a full stop ("Stop please thank
you"), the curly apostrophe accepted; a phone's msg, msgs, txt, txts, sms
and smses read wherever message or text is — "Dont msg me", "no more msgs
pls" — "stop spamming me", "stop stop stop", "remove me" or "remove my
number/mobile/phone" from your/the/this list, with mailing, sms, text,
texting or contact allowed before "list", and since review round 7 "don't
send me (any more) (these) messages (again / any more)", "stop sending
(me) (these) messages (to me / to this or my number)" and "stop
messaging/texting this or my number" — each still anchored at both ends,
so "Don't send me messages after 9pm" and "Don't stop sending me messages"
are not; review round 5 found "stop messaging me please" read as an
ordinary reply) as well as by the prose reader every channel gets. **And
clause by clause** (review round 6): a text of several clauses — split
on sentence punctuation, a comma, a colon (review round 7: "Not interested:
STOP"; never before `//`, so a link's scheme does not make its host a
clause), a semicolon, an ellipsis, a line break or a spaced dash — is an
opt-out when ONE clause, its own ends stripped, is one of those forms, so
"Not interested. Stop" and "Who is this? Stop texting me" are, where read
whole they were ordinary replies — paused, never suppressed, and
resumable. A clause is read more strictly than a message: CANCEL, END and
QUIT never count as one ("Not interested, cancel"), and a keyword's token
there must be digits, capitals or `all`, so "All good, stop worrying" stays
prose — "stop it" and "unsub me" are clause forms of their own since round
7, because "Not interested, stop it" was an ordinary reply. A bare "Stop"
beside any sentence is read as one — "Stop, I want to know more" included —
the trade stated in the source, because a missed STOP is the worse error.
**And a capital STOP ending the text**
(review round 7, `endsInCapitalStop`): the commonest shape of all, since the
footer said "Reply STOP", has no punctuation before the keyword — "Not
interested STOP", "No thanks STOP 56161", "Not interested STOP. Thanks" —
and was an ordinary reply. STOP, STOPALL, UNSUBSCRIBE, UNSUB, OPTOUT or OPT
OUT typed in CAPITALS after at least one word, ending the WHOLE text (never
a clause, so "Bus stop at 5 STOP? no" stays prose), is read as its own
clause, with an optional ALL, one optional footer token, and the decoration
and politeness a whole message may end with. Not after a negation or
"non", an article or a possessive (my, your, our, their, his, her), "full",
or a word that makes it a place or one stop of many — bus, pit, truck,
metro, station, railway, rly, train, tram, terminal, depot, signal, toll,
next, last, first, final, every, each, one ("Please don't STOP", "Working
NON STOP", "the bus STOP", "FULL STOP", "your ONE STOP"); review round 8
found "Working NON STOP", "Meet me at Metro STOP" and "Why STOP" read as
opt-outs — an `opted_out` reply nobody can clear, and a phone suppression in
every org holding the number. "no" and "halt" are left out on purpose: "No
STOP" and "HALT STOP" are commands. Not with a question mark after it; not
STOP BY, IN, OVER or OFF, a visit ("I can STOP BY", from an interested
lead); and in a text typed in capitals throughout only with a token
carrying a digit ("NOT INTERESTED STOP ACMEIN" is a miss chosen on
purpose). **Nor a bare STOP ending a question typed without its question
mark** (review round 8, `asksAQuestion`), read on the clause the STOP ends —
after its last clause break, so "Who is this? Wrong number STOP" is still
one: a clause that opens with a wh-word, or with an auxiliary or a modal and
a word after it ("Why STOP", "Can I STOP", "When does it STOP", "Who said
STOP"; "Do STOP" alone is a command). The exception is a question that ends
before the keyword, whose STOP is the command it looks like: one addressed
to the sender ending in you, me, us, this or that, my number or the texts,
a please, pls, plz, kindly or just set aside ("Can you STOP", "When will
you STOP", "Why are you texting me STOP", "Who sent this STOP"), one
opening "who/what is this…", and "how many times…". Only the bare word is
read this way: STOP with ALL or a short code, and STOPALL, UNSUBSCRIBE,
UNSUB, OPTOUT and OPT OUT, are read in a question as before ("How do I
UNSUBSCRIBE", "who is this STOPALL"), because those exist only to leave a
list. Accepted misses, ordinary replies now — paused and resumable, as each
already was with a question mark: "How do I STOP", "Can I STOP NOW", "When
does it STOP", "This is final STOP", "Not interested FULL STOP". Accepted
false positives, still opt-outs: a place NAMED before it ("Reached Kurla
STOP" — a name looks like any word that ends a sentence), a question whose
wh-word does not open the clause ("Sir why STOP"), a negation not right
before the keyword ("We are never going to STOP"), and "Why did you STOP",
read as a complaint. And one inconsistency, older than round 8 and left as
it was: "How do I UNSUBSCRIBE" is an opt-out, and "How do I UNSUBSCRIBE?",
with its question mark, is not. A lower-case or
title-case "stop" there is a sentence ("I am at Andheri Bus Stop"), CANCEL,
END and QUIT never count this way, and "Not interested STOP - Ravi", a
signature after it, is a stated miss.
Whitespace, punctuation, symbols and emoji are stripped from both ENDS only — `STOP)`, `¡STOP!`, `STOP 👍` — never from
the middle, so "Don't stop! 👍" is still not one (review round 4). The email
reader, `looksLikeOptOut`, was widened by sentences only (review round 6,
which found "Please stop emailing me." read as an ordinary reply — paused,
never suppressed): stop emailing / mailing / contacting / messaging /
writing to / spamming me (again, any more), stop sending me emails or
messages, don't contact / email / message / mail me, and unsubscribe,
remove me, opt out or take me off your/the/this (mailing, email or contact)
list — still a whole first line or a whole short message, behind one
please/pls/kindly and before one please/pls/thanks/thank you/thx. Not by
decoration at the ends, so a decorated "Unsubscribe 🙏" by EMAIL is still
missed; and the SMS footer's token and `all` forms were kept out of it on
purpose, because "stop by" in a mail would become a suppression. **All of
it is ONE transaction** (review round 3): the row, the pause, the cancel, the suppression attempt, the deal
move and the `contact.replied` audit row. They were separate statements with
the row committed first, so a fault after the insert answered 500, the
provider's retry met `handleInboundEmail`'s Message-ID dedupe, and a "Stop"
was left unpaused and unsuppressed while its approved follow-up went on the
next tick. Now a fault rolls everything back and the retry records it; a
stored row is one whose consequences were stored with it, so a redelivery has
nothing to finish (re-applying them on a duplicate was rejected: it would
undo a teammate's resume since) — but for one write, an SMS STOP's phone
suppression that could not be written, which DoveSoft's redelivery writes
where it is still missing (review round 7, §2, "SMS through DoveSoft"). The
three writes that may fail on their own — the suppression, the deal move,
the audit rows — each run in a SAVEPOINT, because a statement the engine
refuses aborts the transaction and a COMMIT sent to an aborted transaction
is answered ROLLBACK with no error, which drizzle resolves (measured on
PGlite): without one, a swallowed failure discarded the whole reply while
the function returned its id
(`packages/db/test/inbound-atomic.test.ts`). The deterministic kind is
written on the row's own INSERT. A U+0000 in a reply's subject, body, From
or provider id is stored as U+FFFD on every channel (an inbound reply's
rule — a template refuses one instead, because it must be the registered
words exactly: §2, "SMS through DoveSoft"), and the words read
are the words stored (review round 5): Postgres refuses U+0000 in text, and
mailparser keeps one decoded from quoted-printable `=00`, so such a reply
failed its INSERT on every retry and a "stop" sent that way was recorded
nowhere. Still open: a NUL in an email's Message-ID reaches
`handleInboundEmail`'s dedupe read unreplaced, before the recorder runs. A
stop reply whose whole transaction rolled
back logs `OPT-OUT NOT RECORDED — the reply was rolled back; a provider retry
records it, otherwise follow up by hand` (ids, `inReplyTo` — the message the
reply answered — `fromIsContact`, review round 7's word on whether the
reply came from that contact, null when the fault came before the contact
row was read, and the error's name), except for a raced duplicate: a
unique violation with a provider id set is 0019's inbound-SMS index refusing
the second delivery of a STOP the first recorded, and a line telling a
person to record it by hand would be false. The
audit rows of such an attempt are not written, so the route's 500 or that
line is the record until a retry lands — the provider's on the webhook
routes, and on IMAP the worker's own, since it leaves a message it could not
record unseen (below); for such a stop the two email webhook routes, the
worker's IMAP inbox and DoveSoft's text route also pause the contact, write
`contact.opt_out_not_recorded` and raise the alarm without waiting for that
retry (§2, "The Resend inbound route is a READER", and "SMS through
DoveSoft") — a contact whose COLLEAGUE sent the stop only as any reply
pauses them, because it was not their opt-out (§2, "The opt-out reader
runs first"). Inbound mail is matched by the Message-ID this system
sent (unambiguous), then by an address that belongs to exactly ONE contact
across every org — two orgs with the same address on file is a reply nobody
can place, and it is dropped and logged rather than filed under the wrong
agency.

**The worker's IMAP path leaves what it could not record unseen, and drains
while connected.** `drainUnseen` in `apps/agent/src/outreach/inbox.ts` marks
a message `\Seen` only when it was handled or never can be: the server
returned no source (expunged meanwhile), it has no readable sender, or the
parser threw (`UnreadableInboundMessage`). A database fault inside
`recordInboundReply` — which rolls the whole reply back, above — or a fetch
that failed leaves it UNSEEN for the next drain. Before, every UID was marked
seen in a `finally`, so a "stop" whose transaction rolled back was never
retried and never recorded: the difference between an opt-out recorded a
minute late and one never recorded at all. Bounded: failures are counted per
UID, in memory (a restart forgets them and retries the message as new — the
safe direction, because the inbound path dedupes on the reply's
Message-ID), and the `INBOUND_MAX_ATTEMPTS`th (5) marks it seen and logs
`INBOUND MESSAGE ABANDONED — handle it by hand` at error, with the UID and
the error's NAME only: the mailbox still holds the message, the log nothing
of it. Only the first failure of a drain is charged, because a database that
is down fails every message behind that one too, and charging each would
abandon the inbox to one outage; the messages behind a failing one are still
tried, so one that will never record does not hold up a "stop" that arrived
after it. The retry waits `DRAIN_TIMING.retryMs` (60 s), doubling per counted
failure and capped at the refresh below — about a quarter of an hour before
the fifth failure, long enough for a database to come back. **A stop is not
left to those retries** (review round 6): one the recorder had placed takes
the webhooks' loud path on its FIRST failure (`stopNotRecorded`) — the
contact paused over any earlier reason, `contact.opt_out_not_recorded`
`{ channel: 'email', why: 'record_failed' }`, and the alarm awaited, naming
the message the reply answered or none, in `inbound-fault.ts`'s shapes;
for a colleague's stop (`fromIsContact: false`, review round 7) the
contact is paused only `replied <ISO>` through `pauseContact`, and the row
and the alarm are about the message the sender answered, as on the
webhooks (`rolledBackOptOutPause`; §2, "The Resend inbound route is a
READER"), while each contact the line names as the sender is held as the
one who asked (`rolledBackSenderHolds`, review round 8) — and the fault is
then rethrown, so the drain still counts and
retries it under the bound above. Before, it was retried and abandoned with
log lines only, while the sender read the contact as clear. The line is
`OPT-OUT NOT RECORDED — a reply that asked to stop could not be recorded;
it stays unseen and is retried, otherwise follow up by hand`, with the UID,
the fault's class, ids, `fromIsContact`, `paused`, `audited`, for a
colleague's stop `senders`, `sendersHeld` and `sendersAudited`, and `alarm:
'raised'|'already_raised'|'off'`.
An `UnrecordedStops` map beside the failure count raises the alarm once per
UID; a pause or audit write that threw is tried again on the message's next
failure, and the UID is forgotten once the message settles — handled,
unreadable or abandoned. A restart forgets it, so a stop still failing after
one alarms and audits again. The inbox now hands the recorder a log, to keep
its rolled-back line, and forwards every line to stderr in the recorder's
own JSON shape (`recorderLines`), where they always went. **And the drain
actually runs on new mail now.** imapflow 1.0.196's `idle()` resolves only
when another command breaks IDLE or the connection drops — an untagged
EXISTS only emits an `exists` event — so the old `await c.idle(); await
drain(c)` loop read mail that arrived during a session only after the server
dropped the connection and the worker reconnected. The session listens for
`exists` and breaks IDLE with a NOOP (imapflow queues commands, so one sent
mid-drain is safe; `woken` remembers it, and the next drain starts at once),
and arms a timer while idle: the retry, or a 10-minute refresh
(`refreshMs`), well inside RFC 2177's 29 minutes, which also catches an
EXISTS that never arrived. `apps/agent/test/inbox-drain.test.ts` proves it
against a fake mailbox and a real migrated database with an engine-raised
fault — a rolled-back "Stop" retried and recorded with its suppression — and
never against a live IMAP server (the Phase 4 table).

**`sending` is the worker's claim** on a row (0011), so two workers picking
one row produce one UPDATE that matches. A worker that died mid-send leaves
a row that says so, and `recoverStuckSends` marks it `failed` with a reason
— the safe direction; the alternative is guessing the provider was not
reached and sending it twice. The reason is worded by the row's own channel
(`STUCK_SEND_ERRORS` in `apps/agent/src/boot/reconcile.ts`): a text "may or
may not have gone; check the DoveSoft console before drafting it again", an
email the same with "check the mailbox", and a LinkedIn step names the
conversation. None says "re-approve to send it again", as the one sentence
for every channel did: `approveDraft` takes only `awaiting_approval`, so a
`failed` row is sent again only as a new draft (`LINKEDIN_STEP_STUCK_ERROR`,
`/tasks`' own stuck-claim sentence, says "draft it again" too). For an answer to a reply it also puts the
reply's pause back, in the same transaction (`repauseForUnansweredReply`,
§2, "Replies have a screen").

**The mail transport stays out of the Next graph.** `@agency/db/queries`
does not export `smtp.ts`: the web app queues, the worker sends, and a
transport that can deliver has no business in a bundle CI builds with no
secrets — the DoveSoft provider lives in `apps/agent` for the same reason.
The inbound webhook (`/api/inbound/email`) is exempt from the
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

**The sender's facts have one gatherer, and every screen reads it.**
`sendFactsFor` gathers exactly what `dispatchTouch` checks, and `previewSend`
runs `decideSend` over them and writes nothing. The contacts ledger, the
send-check route, `check_send`, the approvals page and the inbox's answer
path all show the decision the sender WILL make, from the same function —
never a restatement of the rules that could drift from them. `previewSend`
takes an optional `writtenAt` (an `EvidenceAsOf`, §1) for the stale-evidence
step: omitted means a message written now (the send-check route,
`check_send`, enrolment's dry run); a `StoredWords` means a stored draft,
judged against its stored `created_at` to the microsecond (`/approvals` and
the `/tasks` LinkedIn steps pass `evidenceAsOfFor(touch)`, and `/approvals`
keys its previews by touch id, not by a millisecond); a `Date` means words
written at that instant and stored nowhere (`smsDraft`'s dry run); null
means an answer to a reply (the inbox). A stored draft is asked about on ITS
OWN channel, as the sender sends it, and one whose campaign now sends on
another comes back `ok: false`, reason `missing`, with `channelMismatch`'s
sentence. On SMS and WhatsApp it also takes `words` (a template id and a
body) for the template steps; with none, it answers a question about the
PERSON as if the message were rendered from one of the channel's active
templates — a non-promotional one where there is one — and says so
(`template.source: 'any_active'`), never silently. Beside the facts it
reports `pausedReason`, `pausedFor` (the reason's class), `consentRecorded`
(the row as stored — the same value as `facts.consent`), `evidenceStale`,
`evidenceSuperseded` and, since review round 10, `sharedNumberHold` —
Resume's own answer (`heldForUnrecordedSharedNumber`), asked in
`sendFactsFor` for a paused contact only, one `audit_log` read per send
attempt to one, and false when they are not paused, and since review round
11 only for a pause Resume asks that question about
(`resumeAsksSharedNumber` in `sms.ts`): never their own unrecorded opt-out
or an unfinished erasure, which Resume refuses first, so no reader tells a
person the number would unlock them; `consentLedgerFor` carries it too — for a screen to say, and decides through
`decideGathered`, so a dry run words a superseded scan, and a shared
number's kept holder, exactly as the sender does.

**A pause is its own fact, never a consent.** `SendFacts` carries a required
`paused` and an optional `pausedFor` — a `pauseReasonClass`, never the
reason's text, which can carry a teammate's address or the contact's words
— and `facts.consent` is the row as recorded, for a paused person as for
anybody. `decideSend` refuses `paused` (`humanCanResolve: false`) right
after consent. It used to model a pause as a revoked consent, so a
teammate's hold was logged `consent_revoked` — the recipient's own no — and
enrolment read it that way for ever after the hold was lifted. The paused
branch of `sendFactsFor` also used to short-circuit, so a paused AND
suppressed person read as "not suppressed" on every preview; suppression,
consent and the cap are gathered for them too, and `decideSend` orders the
refusals: a suppression and a recorded refusal outrank the pause. And
`decideGathered` words a `paused` refusal of a shared number's holder whose
own pause stood (review round 10): when `sharedNumberHold` holds and the
class is `replied`, `manual`, `unsubscribed` or `other`, it appends
`SHARED_NUMBER_HOLD_SENTENCE` ("A text from a number they share also asked
to stop, and it could not be recorded — they may not have sent it — so
Resume is refused until the number is recorded on /suppressions."), because
`pausedSentence` alone said "until a person resumes them there" of a pause
Resume refuses. A reply's pause (`replied`) gets a sentence of its own,
`SHARED_NUMBER_HOLD_REPLIED_SENTENCE` (review round 13): its class's words
send a person to answer from `/inbox`, which `replyQueueDraft` refuses
(`SHARED_NUMBER_HELD`) while the number is unrecorded, so it says neither
answering the reply nor Resume lifts the pause until the number is recorded;
`check_send` says the same (`SHARED_NUMBER_HOLD_REPLIED_WORDS`). The sender's own decision (`dispatchTouch`'s return value,
what LinkedIn's Start shows) and every dry run — the ledger's "Why can't I
reach them?", `/approvals`' rule line, enrolment, the inbox's answer,
`smsDraft` — word it alike; the hard hold's own shape, an own unrecorded
opt-out and an erasure keep their `pausedSentence`, which already says to
record something or finish the erasure. `touches.error` is not written for
a decided refusal, so no stored row changes. **Stated residual:**
`dispatchTouch`'s last look before the provider — a pause that landed after
the decision, "This contact was paused a moment ago." — words it with
`pausedSentence` alone.

**The ledger says never-asked, refused and granted are three facts.**
`/contacts` shows each person's consent and suppression answer from
`consentLedgerFor`, which `get_consent` also reads, and a send-check per
campaign through `previewSend`, with the recipient masked to its domain.
Consent recorded there carries the form's wording as evidence; a grant over a
refusal is a 409 (`refused_is_final`), and lifting a refusal is an owner's
explicit act that returns the person to never-asked (§1).

**An edit cannot move a person out from under their own opt-out.** A
suppression is keyed by value, so `contactsUpdate` refuses any edit — a change
or a clear — that would make a suppression row stop matching the contact, and
repeats that condition inside the UPDATE, so a "stop" arriving mid-edit fails
the edit (`changed_meanwhile`). An email moving within a suppressed domain is
allowed. Carrying the suppression over to the new value was rejected: that
would suppress an address that may belong to somebody who never asked. Phones
are stored as E.164 on edit, a LinkedIn URL must be one `normaliseLinkedIn`
can read, and changing the email clears a bounce mark in the same UPDATE.
Nor off a number held for an unrecorded shared-number STOP (review round
9): while `heldForUnrecordedSharedNumber` holds, a phone change or clear
that drops the number's key is refused `shared_number_hold` (409 from
`PATCH /api/contacts/[id]`), and the UPDATE repeats the condition — the
pause it read, and `NOT EXISTS (<a governing row>)` — because the hold is
lifted by the NUMBER's suppression, read off their phone, and a contact
moved off it held a pause nothing could lift. Not over a pause Resume
refuses before it asks (`resumeAsksSharedNumber`, review round 12): their
own unrecorded opt-out or an unfinished erasure is never lifted by Resume,
so it strands nothing, and refused, the phone froze for good behind "resume
them first". Paused or not (review round
11, undoing round 10's "only while paused"): a row that lists a contact
governs every LATER pause of theirs too, judged against whatever phone they
have then, so an unpaused listed contact moved off the number — the
`paused` shortfall, or a Resume that landed before the row committed — had
a later pause Resume could never lift, and it asked for a number that never
said STOP to be recorded. Such a contact hears `SHARED_NUMBER_HOLD_EDIT_UNPAUSED`:
record the number on /suppressions, then pause and resume them on
/contacts, which spends the row. Round 10's own case stays fixed by the
row's spending rule alone: a contact resumed once the number was recorded
is not held, so an owner who then removes the suppression can change the
phone (§2, "The send path"). A change of spelling that keeps the number
goes through; once the number is suppressed, moving the phone off it is
the owner's decision above.

**An import writes no consent row; a company carries a declared zone,
editable, never derived from `country`.** `/contacts/import` drops a phone
`normalisePhone` cannot read and reports it by line, stores a readable one as
E.164, and is idempotent on a re-run: a person matches on email; without one,
on LinkedIn profile; without that, on phone AND name at the same company,
because a shared switchboard number is not one person. It refuses a file that
is not UTF-8, because Excel's plain CSV is Windows-1252 and accented names
would be stored garbled. Company edit (`PATCH /api/companies/[id]`) changes
the name, the country and the IANA zone, through `isKnownTimeZone`.

**Enrolment is the first production caller of `draftOpener`.** It checks a
usable address, consent for the channel, a pause, a bounce and the
recipient's zone, in the send path's order — a person who declined AND is
paused is skipped `declined`, the stronger statement; a contact whose email
bounced (`email_bounced_at` set) is skipped `bounced` on the email channel
only, after the consent and pause questions and before the zone, and the
panel says to correct the address on `/contacts`. It does NOT read the
suppression table: a suppressed contact is enrolled and then refused
`suppressed` by `dispatchTouch`, the one place that rule lives (a dry run
reports a hint count through `previewSend`); what it reads is its own
earlier touches' `refusal_code`, so a `suppressed` refusal there blocks a
re-draft.

**The duplicate guard is one rule, applied by the read and by the INSERT's
own NOT EXISTS.** A `refused` row counts unless its code is one a correction
or a re-scan resolves (`REFUSALS_A_CORRECTION_RESOLVES`: `bounced`,
`unparseable_recipient`, `unknown_timezone`, `band_never_opens` — a zone or
a quiet window to correct, met only on a row another path wrote, because
enrolment drafts no SMS — `stale_evidence`, and `paused`
— a hold, not a no, which stops nothing once a person has lifted it; a
contact paused NOW is skipped before any row is read) or one the clock
resolves (`REFUSALS_THE_CLOCK_RESOLVES`: `quiet_hours`, `daily_cap`,
`campaign_inactive`, which the sender defers rather than refuses, so a row
still refused with one is a deferral a dying worker never restored). A
person's deny (`needs_approval`), the recipient's refusal
(`consent_revoked`, `suppressed`), and any other or unknown code block a new
draft whether or not the campaign auto-sends — the first version ignored
every `refused` row, and re-enrolling must not quietly ask again. A reply's,
an unsubscribe's and an erasure's cancel of queued messages still writes
`consent_revoked`, so those still block; a row in flight when a reply lands
is refused `paused` by the sender's last look, and so is what a shared
number's hold cancels (§2, "SMS through DoveSoft"); alone, neither does. A deny is
`needs_approval` unless the draft's own facts refuse it `stale_evidence`
(judged by `sendFactsFor` and `decideSend` at the deny, from the words'
written-at moment): then the row records `stale_evidence`, which a re-scan
resolves, because the approver's no was about aged evidence and not the
person; a suppression, a recorded refusal or a pause that outranks it
leaves the deny `needs_approval`. The `draft.denied` audit detail carries
the `refusalCode`, and `/audit` says "(its evidence was stale — it can be
drafted again from a current scan)" for one. It said "a re-scan lets it be
drafted again", which is false of words whose scan a newer one SUPERSEDED
(§1): that re-scan already happened, and re-enrolment drafts them again
straight away — and the detail cannot tell the two causes apart, so the
sentence is the one true of both. `failed`
is ignored only where a person approves each draft; under auto-send it
blocks, because `recoverStuckSends` leaves `failed` on a send that may have
gone. And under auto-send the read and the NOT EXISTS look at every
campaign's outbound rows on the channel, not only this campaign's
(`enrolPriorScope`): nobody reads the words, and they depend only on the
company, the ICP and the sender, so campaign B would mail the opener
campaign A already sent. Supervised campaigns keep the per-campaign rule.
`already_enrolled` is a row still `queued`, `awaiting_approval` or
`approved`; anything else that counts — sent, `sending` (a claim that may
already have reached the provider), a denied draft, a recipient's refusal —
is `already_contacted`. A never-scanned company is skipped `stale`, because a
scan fixes both; and a campaign on a cold-forbidden channel is refused whole
(`campaign_channel_unsupported`) — an SMS campaign included, whose texts are
drafted one person at a time with Draft SMS, and whose refusal says so: "SMS
is drafted per person with Draft SMS on /contacts." follows the sentence
every other channel gets, which alone pointed nowhere (a WhatsApp campaign's
keeps it alone). **And the INSERT holds a
lock** (review round 3): an `INSERT … WHERE NOT EXISTS` does not serialise
under READ COMMITTED, so two overlapping enrolments could each insert an
opener for one person — and under auto-send both rows are `queued` and never
reach `/approvals`. Each insert now runs in a short transaction that first
takes `pg_advisory_xact_lock(hashtext('enrol.draft'),
hashtext('<org>:<contact>:<channel>'))` — the channel, not the campaign,
because under auto-send the rule reads every campaign on it
(`enrolPriorScope`) — so the second INSERT waits, takes its snapshot after
the first commits, and its NOT EXISTS sees the first draft.

**A gap with no detail is quoted in the words of what the scanner did, or
not at all** (§2.2). One fallback used to call every such gap "header absent
on homepage response", in a body auto-send mails unread.
`observedWithoutDetail` keeps that sentence for the six header signals
(`csp`, `hsts`, `frame_protection`, `content_type_options`,
`referrer_policy`, `permissions_policy`); `security_txt` and `trust_page`
name the paths from the finding's own `evidence.probed` ("no security.txt
found at /.well-known/security.txt or /security.txt"); `compliance_claim`
reads "no SOC 2 or ISO 27001 claim found on the homepage". Any other gap with
no detail, or a path signal whose row has no usable `probed` list, is not
quoted — it stays in `gaps`.

**The approvals page shows the same facts the sender reads**, from
`previewSend` at the moment the draft's words were written
(`evidenceAsOfFor`), and the evidence behind THAT draft
(`draftEvidenceFrom`): the latest successful scan at or before its
`created_at`, aged at now — the scan the sender judges the words by. It used
to be the company's latest scan on every card, so after a re-scan the panel
listed the new scan's lines under words written from the old one. Lines
(still exactly `quotableFindings`) are listed only when that scan is the
company's latest and fresh; a newer scan gets a plain note pointing at the
company page; stale words with a fresh re-scan since say "deny this draft
and draft it again from that scan"; a draft written before any successful
scan gets `MISSING_EVIDENCE_NOTE` ("No successful scan of this company had
run when this draft was written"), because "never scanned" is false once it
has been scanned since. An answer to a reply never gets
`STALE_EVIDENCE_NOTE` — the sender does not judge it by a scan, and the
warning steered approvers to deny legitimate answers — but
`ANSWER_EVIDENCE_NOTE`, the person's own check that it repeats no finding
that is no longer known to be true. Approve is disabled only for a
`humanCanResolve: false` decision, and the page says so; everything else
stays approvable, because the worker re-checks at sending. A draft written
from a scan that is stale now is blocked as `stale_evidence` with its own
sentence — deny, re-scan, draft again — because "choose someone else" fixes
nothing when every person at the company gets the same aged words;
`STALE_EVIDENCE_NOTE` says "re-scan, then draft it again" where it said
"re-scan, then approve". A draft whose scan a newer successful scan has
superseded is blocked as `stale_evidence` too (§1), so the "newer scan" note
above now sits beside a disabled Approve, and its block has a sentence of
its own: "a newer scan of the company has run since the one it was written
from, and only the latest scan is quoted in anything outbound … Deny it,
then draft it again from the latest scan" — no re-scan, because the re-scan
is what already happened, and "past its re-verification deadline" would be
false of a scan a few days old. Aged words keep "the scan it was written
from is past its re-verification deadline … Deny it, re-scan the company,
then draft it again". `decisionView` in `apps/web/src/lib/approval-view.ts`
tells the two apart by the opening words of the reason `decideGathered`
writes (`SUPERSEDED_REASON`, setting `evidenceSuperseded` for
`approveBlock`), because the page hands it the decision alone and the facts
beside it cannot tell aged-and-superseded (worded as the deadline, the
plainer of two true reasons) from superseded alone;
`apps/web/test/approval-view.test.ts` runs the real `decideGathered`, so a
rewording there fails the test rather than going quiet. A `paused`
candidate's block says the draft can
wait until the pause is lifted, never to deny it: a denial is a person's no,
and blocks re-enrolment — and for a shared number's holder whose own pause
stood (`decisionView(decision, preview.facts)` carrying `sharedNumberHold`,
review round 10) it adds that they cannot be resumed until the number is
recorded on /suppressions (§2, "The send path"). A `no_template` or
`template_mismatch` block says the operator would not deliver it: deny,
then draft again from an active
registered template. `approveBlock(decision, channel)` takes the draft's
channel (`drafts.tsx` passes `d.channel` at every call), and on SMS and
WhatsApp neither the paused block nor the default one says "choose someone
else", because there is nobody else to choose (review round 4): paused
reads "the draft can wait here until then. Its template was filled in for
this one person, so it cannot go to anyone else", and the default block on
SMS "Deny the draft" with the same sentence and "A text to somebody else is
drafted from their own row on /contacts (Draft SMS)". An SMS card names the
template it was rendered from (its DLT id, header and category) and offers
only the contact its slots were filled for (`smsCandidates`, which narrows
a WhatsApp draft the same way, through `TEMPLATE_CHANNEL_NAMES`, a
client-safe copy of core's `TEMPLATE_CHANNELS` that a test holds equal to
it), and `approveDraft` holds every caller to
the same rule: an SMS or WhatsApp (`TEMPLATE_CHANNELS`) draft approved to
anyone but its own `contact_id` — a row whose contact is gone included — is
refused `rendered_for_another` with nothing written, worded by `POST
/api/touches/[id]/decide` (400: it can be approved only to the person it was
written for; draft one for anybody else, an SMS with Draft SMS on
`/contacts`). Only the page's list stood in the way of a direct API call
before, and the words, a template filled with one person's details, would
have gone to a colleague (`packages/db/test/approve-template-draft.test.ts`).
An approved SMS card says it goes only through DoveSoft and only where SMS
is switched on on the worker's host, which this page cannot see — the
dashboard's worker line says whether it is — and that every rule, the
registered template included, is checked again at sending
(`approvedMessage`); with no worker configured it says one must run
elsewhere with SMS switched on, never that "the worker will send it".
Approving or
enrolling LinkedIn says a person sends it from `/tasks`, never that the
worker will, and the note that nothing sends without a worker is not shown
over LinkedIn drafts or a LinkedIn campaign: the worker never sends
LinkedIn (§2, "The LinkedIn provider is a person").
From the keyboard approving is two steps: `a` arms the focused card and Enter
on that same card approves; any other key or a change of focus disarms it
(§2.4). A page load is bounded to 80 previews, four at a time, because
Vercel's pool is one connection; past that a person reads "could not be
checked here — the worker checks again at sending" and is never blocked.

**Replies have a screen.** `/inbox` lists every reply with its kind. A person
may set any kind except `opted_out` and may never clear it — the zod enum and
the query predicate both enforce that — and may not reclassify a reply from
a suppressed person, or an unclassified one that `looksLikeOptOut`.
Reclassifying can START a pause (moving a reply off `auto_reply`, below) but
never ends one. An answer is an `awaiting_approval`
draft naming `answers_touch_id`, which `dispatchTouch` threads through
In-Reply-To/References from the parent's Message-ID (an inbound parent in the
same org only — the §1 trigger). Answering ends ONLY the pause the reply
caused — a reason that is exactly `replied <ISO instant>`
(`pauseReasonClass` is `replied`) — with a `contact.resumed` audit row that
records the pause's class as `pausedFor`, never its text, which can carry a
teammate's address or the contact's words into an append-only log (the
`/contacts` resume records the same, and so does the third writer,
`dispatchTouch`'s lift of a recovery's re-pause, beside `answerTouchId` —
below). Any other pause — a teammate's, an
unsubscribe's, an erasure that could not finish — is somebody else's
decision, and answering is a 409 `paused_for_another_reason` that sends the
person to `/contacts`; before, answering an old reply resumed a person
paused for any reason. **The inbox never drafts to somebody who asked to
stop**: a reply of kind `opted_out`, a suppression on the address on file OR
on the From the reply came from, a recorded refusal of the channel, or a
`contact.opt_out_not_recorded`, `contact.erasure_failed` or
`unsubscribe.not_recorded` audit row naming them (by subject or
`detail.contactId`), however old, is a 409 — the last is
`opt_out_not_recorded`, because an opt-out that failed to store left no
suppression row for the check before it to see — and nobody is resumed.
`opt_out_not_recorded` is also answered when any inbound row of theirs has
`reply_kind = 'opted_out'` and its From's keys (`suppressionKeysFor`; an
unreadable From counts) match no suppression row today — the compliance
page's own predicate, which survives a fault that failed the suppression
AND the audit row beside it, since that write is `.catch(() => {})`. A
COLLEAGUE's stop filed under them (review round 7, §2, "The opt-out reader
runs first") names them only as `detail.filedUnder`, which is deliberately
not read: it was not their opt-out, and read as one it locked them out for
good, however old, even once the colleague was suppressed. Until the
colleague's address is on `/suppressions`, the second reading still holds
them, through the colleague's opted-out reply; recording that address ends
it. **And it is worded as the colleague's** (review round 8): the reading,
`unrecordedOptOut`, answers `{ own, fromAnotherAddress }` — an opted-out
reply whose From `replyIsFromTheContact` shows to be another address is
`fromAnotherAddress`, and one from their own address, or one that cannot be
told apart from it, is `own`, worded and gated exactly as before.
`replyQueueDraft` refuses the second `opt_out_not_recorded` in a sentence
of its own — record THAT address, the reply's From shown on `/inbox`, on
`/suppressions`, never this contact's — and only a suppression on that
reply's own From keys ends it, for Resume too (§2, "The send path"),
because "this person asked to stop … record it by hand" sent people to
record the address of somebody who never asked, which satisfied Resume's
gate while the sender stayed unrecorded. The page says the same:
`inboxTouches` rows carry `fromIsContact`, an `opted_out` row's `suppressed`
is read from its From's keys alone — the key `recordInboundReply` writes and
`/compliance` reads (other rows still use the contact's keys and the From's)
— and `apps/web/src/components/inbox/opted-out.ts` words a colleague's stop
"A reply from another address on this thread (<from>) asked to stop — do
not answer it. <name> did not ask, and is not treated as the one who
asked", with a warning, while no suppression matches that From, to record
THAT address and never the contact's, until which the contact cannot be
resumed or answered. A contact's own stop keeps `inbox-view.ts`'s words.
Past those, the check is the sender's own dry run, inside the draft's
transaction after the resume, so a refusal nobody may approve past rolls
back both; one a person can resolve (quiet hours, the cap, a zone, a paused
campaign) comes back beside the draft as `wouldHold`. Two people answering
one reply are serialised by locking the contact row and then the reply row
(contact before touch, below) — an `INSERT … WHERE NOT EXISTS` does not
serialise under READ COMMITTED; a reply whose contact changed between the
read that learned it and the lock is refused `no_contact` ("The contact
this reply came from changed while the answer was being drafted…") — and
the resume lifts only the pause it READ (`resumeContact`'s `expectedReason`
in the UPDATE's predicate). It used to decide on an unlocked read and then
clear whatever the row held, so an "opt-out not recorded" pause written in
between was wiped; now a pause that changed refuses
`paused_for_another_reason` and rolls the draft back. **An answer that
never goes puts the reply's pause back** (`repauseForUnansweredReply` in
`packages/db/src/outreach.ts`): the inbox resumes a person when the answer
is DRAFTED, because `/approvals` would otherwise refuse the answer itself
as `paused`, and an answer that then did not go left a person whose reply
nobody answered live in every campaign. Round 3 covered the deny alone
(`repauseForDeniedAnswer`, now renamed); round 4 found the same gap behind
an answer that failed at the provider, was refused at sending
(`unknown_timezone`, `bounced`, `unparseable_recipient`) or was cancelled by
a bounce. Every writer that settles an answer `failed` or `refused` now
calls it, inside its own transaction and never caught, so the settle and
the pause land together or not at all: `denyDraft`; `settle`, which every
one of `dispatchTouch`'s terminal states goes through; the bounce's cancel
(`outreachRecordBounce`); and `recoverStuckSends`
(`apps/agent/src/boot/reconcile.ts`), now one transaction, because an
answer that "may or may not have gone" must not leave the person live —
the conservative direction. If the provider had taken that answer after
all, `dispatchTouch`'s correction (`recordRecoveredSend`) lifts the re-pause
in the same transaction as the `sent` UPDATE (review round 5) — left on, it
held a person whose reply WAS answered, and answering the reply again from
`/inbox` resumed them, so a second answer could follow the first. Only
while it is still that pause (`liftRecoveryPause`): the newest
`contact.paused` row naming this answer with `answerEnded: 'failed'` is the
recovery's; no other audit row about the contact is at or after it
(compared in SQL against its stored `created_at`), because a reply that
arrived meanwhile kept the recovery's reason (`pauseContact` keeps the
first) and is unanswered; no inbound row of theirs other than the reply
answered is stored at or after the ANSWER row (review round 6, compared in
SQL against the answer's stored `created_at`), because a reply's
`contact.replied` row is best-effort and stamped at its transaction's
START, which can fall before the recovery's row though the reply committed
after it; and the reason is still exactly `replied
<instant>` (`resumeContact`'s `expectedReason`). It writes `contact.resumed`
`{ reason: 'the answer to their reply went after all', pausedFor:
'replied', answerTouchId }`, actor `system`, which `/audit` words "…who had
been paused by their reply, because the answer to it went after all".
**One lock order, contact before touch:** every writer that holds a person
and one of their messages locks the person first, the order the reply,
bounce and erasure writers always took. `denyDraft` reads the answer row,
locks the reply's contact (`lockReplyContact`, `FOR UPDATE`) and only then
UPDATEs the answer; `recordRecoveredSend`, and since review round 6
`settle` for an answer it ends, lock the reply's contact before their
UPDATE too. `recoverStuckSends` reads the stuck claims, locks the reply
contacts of the answers among them in one `SELECT … ORDER BY id FOR
UPDATE` (`lockReplyContacts`, so two writers holding several people cannot
each wait on the other), and only then UPDATEs the rows it read, still
claimed. `replyQueueDraft` and `reclassify` read the reply unlocked to
learn its contact, lock the contact, then lock the reply and check its
contact is unchanged; when it changed, a draft is refused `no_contact` and
a reclassify starts again in a fresh transaction, at most three times — a contact leaves
a reply only by deletion or erasure, so the second pass locks nobody.
Reclassify, settle, the recovery and the inbox's answer each locked the
touch first until round 6, and so did a deny before round 5; each could
deadlock (40P01) on a real Postgres with an erasure, which holds the person
while it scrubs their rows — the erasure then took the loud "could not keep
its suppression" path for a fault that was never about a suppression — or
with a reply, a bounce or a reclassify for the same person. PGlite has one
session and cannot show it, so a source test pins all six writers
(`packages/db/test/lock-order.test.ts`), and since review round 8 the lock
STRENGTH of `sms.ts`'s holder locks, `holdEach` and `releaseEach`, and
since review round 9 `holdHard`'s — one `FOR NO KEY UPDATE`, no message
touched, never `pauseContactOverriding` (§2, "SMS through DoveSoft"). Two
settles are not an ending (`answerEndedBy`):
a clock deferral (`REFUSALS_THE_CLOCK_RESOLVES`), which the tick and the
LinkedIn step put back `approved`, and a `suppressed` refusal, whose writer
pauses with the stronger reason itself. The unsubscribe, erasure, reply and
reclassify cancels pause the person with their own reason, which
`pauseContact` never replaces, so they need no call; nor do the LinkedIn
step's "I did not send it" and `/tasks`' own stuck-claim recovery, because
an answer is only ever email — no inbound LinkedIn path exists, and the
inbox refuses SMS and WhatsApp. The `replied <instant>`
pause returns only when this answer is what resumed them (`reply.answer_drafted`
says `resumed: true`), nobody resumed them since (no later `contact.resumed`
row, compared in SQL by id, read after the contact row is LOCKED, so a
`/contacts` resume in flight is waited for and then seen), and no other
answer of theirs is on its way. A deny's `contact.paused` row names the
denier and `inboundTouchId`, which `/audit` words "paused a contact at
<company> — the answer to their reply was denied"; every other ending is
actor `system` with `{ reason, alreadyPaused: false, answerTouchId,
answerEnded: 'failed'|'refused'|'bounced' }` — never `inboundTouchId`, so
`/audit` does not call it a deny — and is worded by the generic reason
sentence ("their reply is unanswered again: the answer to it failed to
send"). The answer composer on `/inbox` says the same: "If the draft is
denied, or the answer fails or is refused when it would be sent, the pause
their reply caused goes back on — unless somebody resumes them before then,
or another answer to them is still waiting"; it used to ask the person to
"pause them again here" — a hand step the writers now take themselves.
For a reply from another address on the thread (`fromIsContact` false) it
reads "the pause this reply caused", and since review round 9 the page
says whose reply it was and where the answer goes: the row is headlined
"<from> — another address on this thread, filed under <contact>", opted-out
rows included, and the composer says "This answer goes to <contact>'s
address on file (<email>), not to <from>, the address this reply came
from" and that "this reply, filed under them" paused them. It headlined
the contact's name and said "their reply paused them", true of neither
half, while the answer is addressed through the contact (`recipientFor`)
and so mailed them with nothing on the screen saying so. The words are
pure, in `apps/web/src/components/inbox/sender.ts` (`colleagueHeadline`,
`answerComposerNote`, `resumedLine`); the contact's own reply reads as
before, word for word.
**An SMS or WhatsApp reply is never
answered here** (0019): under DLT an answer must be a registered template,
so `replyQueueDraft` refuses it `template_required` (409, its own sentence:
Draft SMS on `/contacts` for SMS; WhatsApp sending is not built), ahead of
0019's CHECK, which would otherwise have thrown a 500 — an opted-out reply on
those channels still answers `opted_out` first. The queue labels each reply's
channel and offers no free-text Answer on either. Draft SMS resumes nobody
and refuses a paused person, and every SMS reply pauses them, so the hint
in the Answer's place (`answerElsewhere(channel, person)` in
`apps/web/src/components/inbox/channel.ts`) says "Resume them on /contacts
first (their reply paused them), then Draft SMS on their row" when their
reply's pause is the one they hold, and for any other pause only that
`/contacts` says what it is and what lifts it (review round 4).
`INBOX_LEDE` says answering an EMAIL reply resumes the person, and that a
text is answered with Draft SMS on `/contacts`, after resuming them there.

**The opt-out reader runs first, and a genuine auto-reply pauses nobody.**
`recordInboundReply` reads the words before the headers: an auto-reply flag
applies only to a body that did not ask to be left alone. **An auto-reply read
from `Auto-Submitted` — or `Precedence: bulk|junk|list|auto_reply`,
`X-Autoreply`, `X-Autorespond` — no longer pauses a contact, unless its own
words mention removal or departure. That is a behaviour change, flagged.** It
is stored `auto_reply` and skips the pause, the cancel and the advance —
only when the BROAD reader `mentionsRemovalOrDeparture`
(`packages/core/src/mail-signals.ts`, over `ownWords`) finds none of: remove
me, take me off, unsubscribe, opt out, do not / don't contact / email, stop
emailing / contacting, no longer with / at / working, has / have left, left
the company / organisation / business. A hit is an ordinary reply — paused,
queue cancelled, deal advanced — because the narrow opt-out reader, built to
be sure before it suppresses, misses "I have left — remove me from your
list", and with only it such a mail skipped the pause while asking to be
taken off. The broad reader never writes a suppression; that is still
`looksLikeOptOut` alone. Reclassifying an `auto_reply` to a human kind later,
from the inbox, `classify_reply` or the worker's reply-triage model, applies
the pause and the cancel it skipped, and never ends a pause. The model's
kind is written the way a person's is (review round 3): through
`replyReclassifyIfStill` (actor `agent`, audited `reply.reclassified`), only
while the reply still has the kind the model was asked about, so every guard
a person meets applies and a kind somebody set meanwhile stands
(`changed_meanwhile`). It used to be an UPDATE by id, and a header-flagged
auto-reply the model read as a person's became `wrong_person` and paused
nobody. An explicit `Auto-Submitted: no` wins over
any Precedence, because reading a mail as human-written is the direction that
pauses; with no headers at all the behaviour is byte-for-byte what it was. An
opt-out whose suppression cannot be written is audited
`contact.opt_out_not_recorded`, logged `OPT-OUT NOT RECORDED — follow up by
hand`, and, when the reply came from the contact's own address, pauses
the contact OVERWRITING any earlier reason with `opt-out not recorded: reply
<ISO> (<why>)` (class `opt_out_not_recorded`), as the unsubscribe and
erasure paths do — every path that knows an opt-out failed to store goes
through one exported helper, `pauseContactOverriding` in
`packages/db/src/outreach.ts`: this one (and `sms.ts` for the contact a
STOP is filed under — a number's other holders, held with a reason of their
own since review round 8, go through `holdHard` since review round 9, which
writes over a reply's pause, the ordinary hold or an earlier hard hold and
nothing else: §2, "SMS through DoveSoft"), the unsubscribe,
the erasure, since review round 6 a stop whose whole recording threw on
either email webhook, DoveSoft's text route or the worker's IMAP inbox, and
since review round 8 the contacts who ARE the sender of a colleague's stop
(below) — because the ordinary `pauseContact` keeps the
first reason and an older `replied …` left in place let answering that
reply resume them. **A colleague's stop is not the contact's** (review
round 7). `handleInboundEmail` files a reply matched by References under
the contact OUR message went to, whoever answered it, so a colleague in the
thread replying all "please remove me", whose suppression then failed, held
the contact as an opt-out nobody recorded — a pause no Resume lifts and a
row `/inbox` reads however old — and locked out, for good, somebody who
never asked to stop, even once a retry had suppressed the colleague.
`recordInboundReply` now compares the From with the contact's own address
key on the channel (`replyIsFromTheContact`, through `suppressionKeysFor`
and never the domain, which a colleague shares; false only when both
addresses read and differ, because "we could not tell" is not "it was
somebody else") and returns it as `fromIsContact`. When it is false the
contact keeps the reply's own `replied <ISO>` pause, which a person lifts,
and the row is about the stored reply (`subjectType: 'touch'`, detail `{
touchId, channel, why, fromIsContact: false, filedUnder: <contact id> }`),
never naming the contact as subject or `contactId`, the two things the
inbox reads as THEIR opt-out. `/audit` words it "could not record an
opt-out from a reply sent by somebody other than the contact at <company>
it was filed under — the sender is NOT on the suppression list; read their
address from the reply and record it by hand; the contact is not treated as
the one who asked" (for `why: 'record_failed'`, that the sender may not be
on the list, a retry may record it, and to check `/suppressions` for the
address first); it is still an alarm, and `/compliance` counts it with its
company resolved through the touch. The contact's own stop is unchanged,
and holds them as their own opt-out should. **And the sender is held**
(review round 8): with the contact held only as any reply holds them, a
colleague's unrecorded stop held nobody who asked, and a second contact
here at the address that asked to stop was sent their approved message on
the next tick. So `recordInboundReply` also holds every contact of the org
whose address key on the channel is the From's (`contactsAtTheAddress`,
through the exported `addressKeyOf` — the address, never the domain, which
a colleague shares — ordered by id, and read in a savepoint right after the
contact row and before the inbound INSERT, so a rolled-back line can name
them): each paused over any earlier reason with `opt-out not recorded:
reply <ISO> (<why>)` through `pauseContactOverriding`, their queued,
awaiting-approval and approved messages refused `consent_revoked`, and a
`contact.opt_out_not_recorded` row with THEM as its subject, `{ touchId,
channel, why }` — their own unrecorded opt-out, the shape the inbox, Resume
and `/compliance` read. Each write runs in its own savepoint, after the
contact's reply pause, and the `OPT-OUT NOT RECORDED — follow up by hand`
line carries `sendersHeld`. When the recording itself throws, the
rolled-back line carries `senderContactIds` (ids only) and the fault paths
hold them by id (§2, "The Resend inbound route is a READER"). Two residuals,
stated: two colleague stops crossing between the same two contacts at once,
both unsuppressed, lock them in opposite orders, and a deadlock there aborts
only the sender-hold savepoint, which is logged while the reply commits
(PGlite cannot show it); and `previewSend` and `check_send` still word the
filed contact's hold as an ordinary `replied` pause, which promises an
answer from `/inbox` that `/inbox` refuses until the colleague's address is
recorded. (`pauseContact` takes
an optional `replacing` reason and replaces a pause whose stored reason is
exactly that one. Its callers are the `/contacts` Pause,
`contactPauseByHand`, where a teammate's hold REPLACES a reply's pause, so
the class becomes `manual` and the inbox will not lift it — over any other
pause, Pause is a 409 "that pause stands" and writes nothing: a manual
reason would turn an unrecorded opt-out's or an unfinished erasure's pause
into one Resume lifts. The route writes `contact.paused` with `alreadyPaused:
false`, plus `replacedPauseFor: 'replied'` when it replaced one, which
`/audit` words "…, replacing the pause their reply caused" — the CLASS, never
the replaced reason's text. And, since review round 7, the shared-number
hold in `sms.ts` (`holdEach`), which replaces a holder's reply pause the
same way — §2, "SMS through DoveSoft".) It is returned as
`optOutNotRecorded`, beside `fromIsContact` — on the matched branch of
`InboundOutcome` too (false on a duplicate), so `/api/inbound/email` and
`/api/inbound/resend` send the `opt_out_not_recorded` Slack event (`path:
'reply'`) AWAITED, in place of the ordinary reply message — for a
colleague's stop `{ contactId: null, fromIsContact: false }`, naming the
stored reply and never the contact, whose address is the wrong one to
record, from the web's `optOutNotRecordedNotification` and the worker's
`optOutNotRecordedEvent` alike — and still answer 200: a retry would be a
duplicate and record nothing more. (A stop whose
whole recording threw is the other case: nothing was stored, so those
routes answer 500, pausing the contact and raising the same alarm first
when the recorder had matched one — §2, "The Resend inbound route is a
READER".) The worker's IMAP path raises the same alarm now, awaited and
before the reply triage — and, since review round 6, on the first failure
of a stop whose recording threw (§2, "The worker's IMAP path leaves what
it could not record unseen") — through `apps/agent/src/notify.ts` when the worker has
`SLACK_WEBHOOK_URL` — the same bytes as the web's, built by
`packages/core/src/slack-payload.ts`, linked through the worker's
`WEB_PUBLIC_URL` (without one the link line reads "Record it on the
Suppressions page in the app."), with a `notification.sent|failed` audit
row.

**A bounce is evidence about an address, not a person asking to be left
alone.** It is a column and a refusal — `bounced`, ordered after consent,
the pause and stale evidence with the order asserted, and
`humanCanResolve: true`: correct the address — never a suppression row. It
used to sit right after `suppressed`, and moved because a person who had
declined, or was paused, and whose address ALSO bounced read as `bounced` —
resolvable — so `/approvals` enabled Approve and the inbox resumed them. A
delivery report of any kind is never filed as a reply; before, a DSN from
a server that sets References was recorded as the contact replying, which
paused them and moved the deal to `replied`. The
IMAP parser reads a report only when the mail's ROOT Content-Type is
`multipart/report`, and the Resend route applies the same root rule: a delivery report nested inside an inline-forwarded
message is read as the reply that wraps it, so a prospect's "please
unsubscribe me" forwarding a bounce inline is an opt-out, not a bounce of our
message. A report is acted on only when it is tied to a message this system
SENT (the returned copy's Message-ID, the MTA's `Original-Message-ID`, or the
report's own References), the address it names is the one that message went
to, and that address is still the contact's; otherwise it is audited
`contact.bounce_unmatched` and nothing changes. `5.2.2` (mailbox full) is
transient although its class is 5, per RFC 3463, and a transient failure is
recorded and changes nothing. `dispatchTouch`'s last look before the provider
refuses a contact deleted or erased in between as `consent_revoked`, without
calling the provider or writing the recipient back (the erasure blanked it
on purpose); then, in `decideSend`'s order, it re-checks suppression by
address and domain BEFORE the pause, because an unsubscribe landing in that
window writes a suppression and a pause, and is the opt-out; refuses a fresh
pause as `paused` ("This contact was paused a moment ago." plus the class's
`pausedSentence`), where it wrote `consent_revoked` "This contact replied a
moment ago"; and re-reads the bounce mark. The final `sent` UPDATE matches
only a row still in flight — `sending`, or the status a direct caller handed
in — so a row somebody else settled meanwhile is not overwritten, with one
exception, made by a second UPDATE (`recordRecoveredSend`) that runs only
when the in-flight one matched nothing: a row a stuck-send recovery marked
`failed` while the provider had it (`failed`, `sent_at` and `refusal_code`
NULL) is recorded `sent` with its `provider_id`, `sent_at` and recipient,
and the recovery's "may or may not have gone; check … before drafting it
again" error is cleared — the provider's acceptance is better evidence
than "may or may not have gone", and left `failed` the row could not be
tied to a reply or a bounce by its Message-ID and a supervised re-enrolment
drafted the same opener again. For an answer to a reply it locks the
reply's contact first and lifts the pause the recovery put back (§2,
"Replies have a screen"). A refusal settled over such a row — this dispatch
never reached the provider — clears the recovery's error too, unless the
refusal brings its own (review round 5), because "may or may not have gone"
is false of it. Neither `sent` UPDATE nor a
refusal's settle writes `recipient` back to a row whose `contact_id` is now
NULL. A campaign that bounces past `OUTREACH_BOUNCE_PAUSE_PCT` (default 5;
30 days, at least 20 people written to) pauses itself — the existing
`campaign_inactive` deferral is the stop — and its window restarts after the
pause. The check runs BEFORE the tick's send pass, not after it: the bounces
that cross the threshold arrive between ticks, and a pause taken after the
pass let up to a whole batch more go to a list already known to be bouncing.
It runs only on a tick that sends email: a bounce is about an address, so a
worker with DoveSoft and no mailbox pauses no email campaign.
**Residual risk, stated:** anyone who can mail the agency inbox can
write a DSN, so a report is believed only when it names one of our
Message-IDs AND the address that message went to — in practice the
recipient, or somebody they forwarded our mail to. The effect is bounded:
email to that one address stops until corrected; it suppresses nobody and
touches no other contact. It pauses nobody but in one case: when the
messages it cancels include an answer to that contact's reply still waiting
to go, it puts that reply's own `replied <instant>` pause back
(`repauseForUnansweredReply`, under its guard), because an answer that will
not go leaves the reply unanswered — the conservative direction, and a pause
a person lifts by answering again (review round 5).

**A click IS the opt-out** — the fourth way a suppression row is written,
after the suppressions page, a reply (an email, or since 0019 a text through
DoveSoft) and an opt-out spoken or texted to the voice service's number
(source `voice`, §1). The token is
`${touchId}.${hex HMAC-SHA256(UNSUBSCRIBE_SECRET, touchId)}`: it names the
touch row and nothing else — no address, no expiry, no org. The minter is
exported from the `@agency/db` root only; the web verifies through `queries`
and computes its own MAC rather than importing the minter. `recordUnsubscribe`
suppresses the address the message was DELIVERED to (`touches.recipient`)
first, and the contact's current email too when it differs, all under the
touch's org; a deleted contact still records. The loud path — a NULL
recipient, an `addSuppression` that returns `ok: false` or throws, any
intended row missing — audits `unsubscribe.not_recorded`, logs `OPT-OUT NOT
RECORDED — record it by hand` at error, AWAITS the Slack notice (never
`after()`: this is the one event that must not be lost to a host without
`waitUntil`) and answers 500; the pause and the cancel run on that path too,
and the pause OVERWRITES any earlier reason with `opt-out not recorded:
one-click unsubscribe <ISO> (<why>)`, because an older `replied …` left in
place let answering that reply resume a person whose opt-out was never
recorded. One kind of NULL recipient is not loud: an erased message whose
`contact.erased` row names it in `suppressedRecipients`, where that
suppression row still exists, answers done (200, `erased: true`, no alarm),
because the erasure provably put its recipient on the list first. Any other
NULL recipient, including a kept row an owner has since removed, is still
loud. A repeat click is idempotent. A GET only redirects to the page, because
link scanners prefetch. A token in the right shape whose MAC does not verify
under the web app's secret — a worker that minted it under another
`UNSUBSCRIBE_SECRET`, which refuses every one-click unsubscribe from that
worker's mail — still gets the stranger's 404 with no hint, and since review
round 9 is logged at error once per process per surface, by path and never
the token: the click (`/api/unsubscribe`) as `OPT-OUT NOT RECORDED — a
one-click unsubscribe link in the right shape did not verify under this web
app's UNSUBSCRIBE_SECRET…`, and the page (`/unsubscribe`) with a sentence of
its own (`logMismatchOnce` and `TOKEN_SHAPE` in
`apps/web/src/app/api/unsubscribe/[token]/mismatch.ts`, shared by the route
and the page). Only a MISSING secret was logged before; a wrong one was
silent. The worker adds
`List-Unsubscribe`/`List-Unsubscribe-Post` only with both
`UNSUBSCRIBE_SECRET` and `WEB_PUBLIC_URL`, and in production refuses to boot
on a `WEB_PUBLIC_URL` that is not `https:` on a public multi-label host —
RFC 8058 one-click needs an HTTPS URI, and mailbox providers ignore any
other.

**The LinkedIn provider is a person.** `linkedinHumanProvider(userId)` is a
`MessageProvider` whose `send()` sends nothing: it hands the words to whoever
pressed Start and answers `human:<userId>`. Two presses, in that order. Start
claims the row `sending` (the tick's own predicate, so two clicks give one
hand-over and one `claimed`) and runs `dispatchTouch`, so every §2.1 rule —
suppression by the 0016 `in/slug` key included — is checked at that moment.
The words reach the screen ONLY on the success path, and the row settles
`sent` in the same request; a refusal hands over nothing, and a clock refusal
restores `approved` plus `scheduled_for` exactly as the worker's tick does,
pinned by twin-row tests. The person sends when they get to it, which can
be the next morning, so every read of `/tasks` re-runs `previewSend` for a
handed step (with `evidenceAsOfFor(touch)` as `writtenAt`, so a re-scan
after the words were written does not freshen them) and the server
WITHHOLDS the words — they never reach the client — when the answer is a
refusal nobody may approve past, the contact is paused, the contact or
campaign is gone, or the hand-over is older than `LINKEDIN_HANDOVER_HOURS`
(24). The row is never auto-failed for any of these — the person may
already have sent it, and a guessed `failed` is a claim — so "I sent it" and
"I did not send it" stay open. The copy reads "Every rule passed when <who>
pressed Start (<time>)", a clock refusal (quiet hours, a paused campaign)
shows as a line beside the words, and `deferred` is decided on the server.
"I sent it" closes the step's task; "I did not send
it" marks the row `failed` with `sent_at` cleared, so the daily cap stops
counting it (the deal is left where the forward-only move put it). Either is
ONE transaction (`linkedinFinishStep`, review round 3): the task's
completion, the `failed` UPDATE, `task.completed` and `linkedin.<outcome>`
land together or not at all. The completion used to commit first, so a
fault before the UPDATE left a message the person said never went recorded
`sent` — counted by the cap, read by enrolment as contacted — and the retry
found no open task and answered `alreadyDone`; now a fault leaves the step
open and the retry does all of it, and the step's audit row is no longer
caught, because a caught failure inside a transaction aborts it and the
COMMIT would undo the rest without a word. **And no other screen prints
words `/tasks` withholds**: the company page's Conversation panel printed
every touch's body, the withheld words one click away, and the agent's
`get_company_timeline` printed each message's subject and first line.
`linkedinThreadWithheld` (`packages/db/src/linkedin-step.ts`) is `/tasks`'
own rule for both — no subject or body for an outbound LinkedIn message Start has not
handed over (an awaiting, approved, queued, refused or failed row included),
nor for a handed one whose step is open and whose re-check withholds it;
a handed message whose step is closed is history, and shows. `/tasks`
materialises one `linkedin_send` task per approved or queued LinkedIn touch on
read, so it works with no worker, and fails its own claims left `sending`
past 30 minutes; `recoverStuckSends` is untouched and still covers them.
`send.sent` reads "via human" for this path.

**Erasure keeps the suppression.** Suppression rows first, everything in one
transaction, and a suppression that cannot be stored aborts the erasure and
fails loudly (§2.1's Phase 4 obligation) — rolled back, the contact paused
with the reason (OVERWRITING any earlier one through
`pauseContactOverriding`, as the unsubscribe and reply paths do),
`contact.erasure_failed` audited, `OPT-OUT NOT RECORDED` logged, the Slack
notice awaited, 500. A completed erasure's `contact.erased` detail carries
`suppressedRecipients` — `{touchId: suppressionId}`, ids only — which is how
a later click on an old unsubscribe link is recognised as already recorded.
Owners only, with the contact's id
typed back as confirmation; downloading the record first is any member's, and
audited as `contact.exported` BEFORE the file is produced (no audit row, no
file). The keys kept: the contact's email, E.164 phone and LinkedIn `in/`
slug, the recipient of every outbound message, the number on every linked
call, and the key each of their opt-outs was recorded against — never the
email's domain or a `company/` page, either of which would silence the whole
company, and never the From of an ordinary reply, which may be a colleague in
the thread. A contact-row value that cannot be read aborts (a person can fix
it); a historical one is skipped and reported, or the person could never be
erased. An opted-out reply keeps its From and an opted-out call its numbers,
with their words scrubbed, because the compliance page re-derives every
opt-out's key from them. **Not scrubbed, and the page says so:** chat
transcripts, audit detail, free text about the company that names them, and a
recording held at Twilio — the result returns the call SIDs for a person to
delete by hand. Audit detail is ids and counts by design, with two kept
exceptions the record and the erase dialog both name: a reason a teammate
typed, and the `suppression.*` rows, which carry the address or number they
changed and outlive an erasure for the reason the suppression does (§4).
The downloadable record includes them as `suppressionAudit`
(`auditSuppressionHistory`), and its `suppressions` list is read by every
key their history matches — every outbound recipient, an opted-out reply's
From, call numbers, and each email's domain — not only the contact row's.

**The Resend inbound route is a READER.** It verifies the Svix signature
(in-repo, pinned to Svix's published vector), fetches the message, maps it to
`handleInboundEmail` and can send nothing — no second matcher, and the same
opt-out reader the IMAP listener and `/api/inbound/email` use. Its status codes
are decisions about retrying: an unfetchable message is 502 and a recording
failure 500, so Resend retries both; everything it read is 200, because a
2xx for an unread message could swallow a "stop". The generic
`/api/inbound/email` answered 200 or let a fault escape whole, and since
review round 5 it keeps the same rule: it catches a recording fault, logs
the fault's class only — drizzle's message quotes the address and the
words, and Next logs an escaping error whole — and answers 500 so the
provider retries. On both routes a stop whose recording threw takes the
loud path before that 500 (`inboundEmailNotRecorded`, and `raisingOnFault`
around the Resend reader's recorder, both in
`apps/web/src/app/api/inbound/email/fault.ts`): the contact paused first,
over any earlier reason (`pauseContactOverriding`, `opt-out not recorded:
reply <ISO> (record_failed)`, class `opt_out_not_recorded`; review round 6
— the row and the alarm told people, but the sender reads neither, so the
contact's approved follow-up went on the next tick until a retry landed),
a `contact.opt_out_not_recorded` row `{ channel: 'email', why:
'record_failed' }` under the contact, and the awaited alarm naming the
message the reply answered, or none when it was matched by address — each
write tried on its own, and the error line saying `fromIsContact`,
`paused` and `audited`. Whose it was comes from the recorder's own
rolled-back line (`keepingRolledBackOptOut`), so nothing is read again from
a database that just failed — and so does whether it was theirs (review
round 7, §2, "The opt-out reader runs first"): when the line says
`fromIsContact: false`, a colleague's stop, the contact is held only as any
reply holds them, through the routes' `hold` dep (`pauseContact`, `replied
<ISO>`, which keeps a stronger pause), the row is about the message the
sender answered (`subjectType: 'touch'`, the subject `inReplyTo`; detail `{
channel: 'email', why: 'record_failed', fromIsContact: false, filedUnder
}`), and the alarm goes with `contactId: null` and `fromIsContact: false`.
And the SENDER is held (review round 8): the line names the contacts of the
org at the From's address as `senderContactIds`, found before the fault,
`keepingRolledBackOptOut` keeps them, and each is paused over any earlier
reason with the `record_failed` reason and given a `contact.opt_out_not_recorded`
row with them as its subject (`rolledBackSenderHolds`), by id, with nothing
read again — paused and audited, not cancelled, as the contact's own fault
path is, because the pause is what the sender's last look refuses; the
error line adds `senders`, `sendersHeld` and `sendersAudited`.
A line that does not say — the fault came before the recorder read the
contact — is read as their own, the conservative direction. That reader,
and the pause (`rolledBackOptOutPause`, `{ reason, overriding }`), the
audit row and the alarm it leads to, live in
`packages/db/src/inbound-fault.ts` (pure, exported
from `@agency/db` and `@agency/db/queries`; `fault.ts` re-exports the
reader), because the worker's IMAP inbox takes the same path for the same
fault and a person in `/audit` or Slack must not be able to tell which
process noticed. A fault before the recorder ran leaves nothing saying
whose, so nobody is paused on a guess, and a stop is logged at error with
`alarm: 'not_raised_unplaced'`. The recorder's lines on both routes go to
the web logger. An HTML-only reply is converted to text
with its lines kept, so a one-word "Stop" above a `<blockquote>` reads as an
opt-out. The worker's IMAP path uses the same converter now
(`htmlToText` in `packages/core/src/html-text.ts`), closing what was an open
finding here: mailparser converts a ROOT `text/html` itself and keeps its
lines, but an HTML part BELOW the root — Outlook's `multipart/related`, a
`multipart/alternative` with no plain part — was flattened to one line, so
the same reply paused the contact and was never suppressed. The parser also
reads the HTML when the plain part is blank, the Resend mapping's rule. The
converter runs in linear time: its regex passes were quadratic on HTML with
no closing marker, and anybody who can mail the agency could burn about
50 s of CPU per message on either path (round 3). **A bounce through Resend
is recognised now.** When the root is `multipart/report` AND a
`message/delivery-status` attachment is listed — both, the IMAP parser's
root rule — the route fetches that part and the returned copy through `GET
/emails/receiving/{email_id}/attachments/{id}` → `download_url`, and hands
them over as `dsn` and `originalMessageIds`. The API key goes only to
Resend's own API; the signed `download_url` is fetched without it, must be
`https:` on a public DNS name with no userinfo or port (not pinned to one
Resend host, because the docs name two), and is never logged; each part is
read to at most 64 KB under one 10 s deadline for the whole report. An
unreadable part is a 502, so Resend retries.

**Not built:** SendGrid behind the provider interface (the interface is the
point; the second implementation is a few lines when it is needed); any
automation of LinkedIn — the provider is a person, by design; multi-step
sequences (enrolment writes one opener per person); and the campaign's
`icp_profile_id` (enrolment qualifies against the active ICP; nothing sets or
reads that column).

### SMS through DoveSoft (0019)

**An Indian SMS is the registered words or it is nothing.** Under TRAI's
TCCCPR 2018 every commercial SMS to an Indian number goes through DLT: the
header (sender id) and a content template are registered there as a pair,
and the operator scrubs each message against them — text that is not the
registered body with each `{#var#}` filled in is not delivered. So the
product never sends free text by SMS. Everything below is that rule, kept on
our side before a message is paid for; the DND scrub stays the operator's,
because nothing here can see the DND registry and nothing pretends to.

**The schema (0019).** `message_templates` holds the registrations — channel
(`sms`, `whatsapp`, `voice`), `external_id` (the DLT template id, exactly what
the provider is told), `sender_id` (a six-character upper-case DLT header for
SMS, `message_templates_sms_sender_is_a_dlt_header`), the category (DLT's
`promotional`, `transactional`, `service_implicit`, `service_explicit`, or
Meta's three for WhatsApp, `message_templates_category_fits_channel`), the
body with its slots, `language` and `active` — `UNIQUE (org_id, channel,
external_id)`, so a re-import is idempotent, and `UNIQUE (id, org_id,
channel)`, the triple `touches.template_id` references (`ON DELETE RESTRICT`:
the registration a sent message was checked against outlives the message,
or "it matched its template" is a claim with no evidence). The delivery
columns and the inbound index are §1's. A row is a REGISTRATION, written by a
person from the portal and never by a model, and it is never edited: DLT
issues a new id when a body changes, so a template that should stop being
used is switched off.

**The rules are pure, in `packages/core/src/dlt.ts`.** `parseTemplate` reads
a body into literals and slots — `{#var#}` and the pre-tagged kinds TRAI's
August 2024 direction added (URLs, call-back numbers and the like must sit in
a slot tagged for them); a kind nobody listed is refused when parsed, never
read as literal text. `renderTemplate` fills the slots in order and refuses
too few or too many values, a blank one, one over `DLT_VAR_MAX_CHARS` (30,
counted in code points as the operator counts), one a tagged slot was not
registered to carry, and a link or a call-back number a slot was not
registered for. **That last is judged on the RENDERED text, never value by
value** (`smuggledRuns`, review round 4): `https:/` and `/evil.example/x` in
two adjacent slots are each harmless and together a link, and `98765` beside
a literal ` 43210` is a phone number. A link is any `scheme://`, `www.`, a
host with a `/path` on any TLD (every shortener), or a bare host on a listed
TLD set that leaves out the English-word ones (`me`, `to`, `at`, `is`, …),
so "Dr.Rao" passes; a number is 7–15 dialable digits with a group of three
together, after dates, times and paise amounts are blanked and with a run
after a currency left alone. A `{#var#}` or `{#alphanumeric#}` slot may not
touch one, alone or joined to its neighbours; `{#url#}`, `{#urlott#}` and
`{#email#}` may carry a link, and `{#cbn#}` and `{#numeric#}` digits (an
OTP, an order number); a run the template's own fixed text makes is the
registered text, and passes. The renderer names the slot, reuses
`var_wrong_kind`, and never quotes the value. A company's bare domain typed
into a plain slot (`rentman.io`) is refused now, as is a 7–15 digit
reference unless it is glued to letters (`INV1234567`) or sits in a
`{#numeric#}` slot. `matchesTemplate` is the operator's scrub run first: exact, no
case or whitespace folding, compared in code points, and a
dynamic-programming match rather than a regex, so literal text needs no
escaping and adjacent slots cannot send a backtracking engine exponential;
it applies the same rule inside the match, the runs found once per text and
each slot placement checked by two prefix-sum subtractions, so the sender
refuses `template_mismatch` whatever wrote the text.
`PROMOTIONAL_WINDOW` is TRAI's band, 10:00–21:00 IST (not the 09:00 of the
2010 rules, cited in the file). `promotionalBand(now, zone, recipient)`
answers `{ open, india, opensToday, nextOpen }`: 10:00–21:00 where the recipient is,
for every number, and TRAI's band as well only for a +91 one
(`isIndianNumber`, through `normalisePhone`, so `0091 98765 43210` is
Indian and a number with no country code is not — and an unreadable one is
refused `unparseable_recipient` long before the clock).
`opensToday` is false when the two never overlap at the offsets in force
(§2, "The clock is not a refusal"). `nextOpen` is the first whole minute
after now at which the band is open, at those offsets, and null exactly
when `opensToday` is false; it is the band alone, so the send path asks
`nextOpenMinute` itself for a minute the campaign's quiet hours leave open
too (`retryAt`). It replaced `promotionalWindowOpen`,
which applied IST to every number, Indian or not, and deferred a band that
never opens for ever. `smsOptOut`
is the keyword reader (§2, "A reply does four things"). `decideSend` reads
`TemplateFacts { active, matches, category }` for `TEMPLATE_CHANNELS` (SMS
and WhatsApp) — required, like `evidenceStale`, so a caller cannot forget the
question — and the sender reads them off the ROW (`templateFactsFor` runs
`matchesTemplate` over the stored body), never from a caller's claim.

**Drafting is one person at a time** (`smsDraft` in `packages/db/src/sms.ts`).
Draft SMS on `/contacts` (`POST /api/contacts/[id]/sms`, `campaigns:write`)
renders an active SMS template with the values typed, live in the composer
with GSM-7/UCS-2 segment counting (160/153 and 70/67) — an extension-table
character (`€ [ ] { } ~ ^ \ |` and the form feed) makes the preview UCS-2,
because the provider's `needsUnicode` sends it that way, and
`apps/web/test/sms-composer.test.ts` holds the composer's set to the
provider's over every code point to U+03FF plus `€` and `₹`; it promised one
segment for a text billed as three (review round 4) — puts the exact words
through `previewSend` and, unless that answers a refusal nobody may approve
past, writes an `awaiting_approval` row naming the template, the rendered
text and the contact's E.164 number, with an `sms.drafted` audit row (ids
only). It refuses, with a sentence, a campaign that is not an ACTIVE SMS
campaign, a template that is not an active SMS template of the org, values
that will not render, a contact with no readable number, and a second live
draft to the person under that campaign (`already_queued`, serialised under
`pg_advisory_xact_lock(hashtext('sms.draft'), …)`). A refusal a person CAN
resolve — quiet hours, the promotional band, the cap, a missing zone or a
band that never opens — is drafted anyway and reported as `wouldHold`. The
composer says "would wait" only where the worker waits — `DEFERRED_CODES`
(`quiet_hours`, `daily_cap`, `campaign_inactive`) — and "would be refused at
sending … fix it before approving" for any other resolvable hold, a missing
zone and `band_never_opens` included, which the tick refuses for good. Its Check is `smsDraft`'s
own dry run (`dryRun: true`, review round 4): every check above in the same
order, the campaign's status and the live-draft (`already_queued`) read
included, stopping before the insert with a `SmsDraftCheck`; it used to be
the route's own `previewSend` call, which skipped both and offered a Draft
that then answered 409. The route sends Check and Draft through
`smsComposerAnswer` (`apps/web/src/app/api/contacts/[id]/sms/outcome.ts`),
which catches a database fault — 500 with a sentence, and a log line naming
the fault's class only, because drizzle's message quotes the number and
the words typed. **SMS campaigns** exist on `/campaigns` (`campaignInput`
accepts `sms`), never auto-send — the form cannot tick it, and the schema
refuses it with a sentence on the field rather than forcing it off — and
offer no Enrol button: enrolment refuses them whole.

**Sending is the one send path with a second provider.**
`apps/agent/src/outreach/dovesoft.ts` is a `MessageProvider` with
`channels: ['sms']` that decides nothing: `dispatchTouch` has run every
rule, and hands it the words, the number and the registration the words
were checked against (`MessageProvider.send` takes an optional `template`:
`externalId`, `senderId`, `category`, `language`, read from the row; a
template-channel row whose registration cannot be read at dispatch is refused
`no_template`, never sent bare). The request is DoveSoft's published one
(the MoEngage partner guide): `POST <DOVESOFT_BASE_URL>/api/json/sendsms/`
with the `key` header and `Content-Type: application/json`, `senderid`,
`unicode`, `entityid` (`DOVESOFT_ENTITY_ID`, the DLT PE ID) and `tempid` in
the query, and `{"listsms":[{"sms","mobiles","senderid"}]}` as the body.
`unicode` is `1` exactly when a character falls outside the GSM 03.38 basic
set — the extension table (`€ [ ] { } …`) counts as outside, the safe
direction, because a gateway may mangle an escape and a mangled DLT text is
scrubbed. Before any request it refuses (`DoveSoftRefusedError`) a missing
registration, a header that is not a DLT header, a template id that is not
1–64 of `[0-9A-Za-z_-]`, a recipient `normalisePhone` cannot read — a bare
national number is refused, never guessed into India — and blank words;
and, with no key or entity id, `DoveSoftNotConfiguredError`. One attempt,
10 s, `redirect: 'error'` (§1, Secrets). A timeout or network failure is
`DoveSoftUnreachableError`, a non-2xx `DoveSoftHttpError` with its status,
and a 2xx with no readable message id `DoveSoftResponseError`; each message
says the text may or may not have been accepted and to check the DoveSoft
console before it is sent again, and none carries the key, the number or
anything DoveSoft said back. The row is left `failed`, never retried: a
second request after a timeout could be a second text.

**One provider per channel in the tick.** `senderProvidersFrom` in
`apps/agent/src/worker.ts` builds the SMTP mailbox for email (`SMTP_HOST` and
`MAIL_FROM`) and DoveSoft for SMS (`DOVESOFT_API_KEY` AND
`DOVESOFT_ENTITY_ID` — either alone is off, said at boot by NAME, at warn
when half is set), and the sender runs when either exists. Each due row goes
to the provider that names its channel, and `dueTouches` is asked only for
the channels carried, because `dispatchTouch` refuses a channel its provider
lacks WITHOUT touching the row: a row claimed `sending` for a channel nobody
carries could be neither sent nor put back. So an approved SMS on a worker
without DoveSoft stays `approved`, and the tick logs `sms rows waiting: no
provider` by touch id only, once, and again only when the waiting set
changes. Nothing ever hands the tick a provider for LinkedIn (a person sends
it), voice (no code places a call) or WhatsApp (not built), and a test pins
that no configuration yields one. The boot line and the heartbeat's `detail`
carry `sms: 'on'|'off'`; `/readyz` does not. The web reads it off the row
(`heartbeatSms`, §2, "Notifications and the heartbeat"), so a worker with
DoveSoft and no SMTP — whose `outreach`, the MAILBOX, reads `disabled` — is
a worker that sends, on the dashboard, `/settings` and `/compliance` alike
(§2, "The settings pages and the dashboard").

**Delivery reports and texts back arrive at the web, never the worker.**
`/api/inbound/dovesoft/dlr` and `/api/inbound/dovesoft/sms` are public paths
(under `/api/inbound`, already exempt from the cookie gate) authenticated by
`DOVESOFT_WEBHOOK_SECRET` — the `x-dovesoft-token` header or a `token` query
parameter, compared in constant time — and answer **503** to everything while
it is unset (an open inbound-text route would let anyone pause a contact or
write a suppression) and **401** to a wrong token. **The query value is read
twice** (`tokenFrom`, review round 4): as `URLSearchParams` reads it, where
`+` is a space, and percent-decoded with `+` left alone (`rawQueryValue`),
and either may match. About half of all `openssl rand -base64 32` secrets
contain a `+`, which is what these docs recommended, and one pasted raw into
`?token=` refused every push, every STOP included, with nothing in any log.
`openssl rand -hex 32` is the recommendation now, because it needs no
escaping anywhere; a secret with any other character is percent-encoded
where it stands in the URL (`+` is `%2B`). The first refused token on each
route is logged once per process at error, by route name only
(`logRefusalOnce`) — never per request, because anybody can send a wrong
token. GET and POST alike, the
fields read from the query, a form or a JSON object under short alias lists
(`webhook.ts`: a new name is one string), bodies bounded at 16 KB. **A GET
push puts its fields in the URL**, so for an inbound text the SENDER'S
NUMBER AND THE WORDS land in the platform's request log (Vercel's, and
DoveSoft's own), beside the token; the routes' own lines never carry them
and cannot stop a platform logging a URL. GET is kept on purpose, because a
STOP that cannot arrive is worse and Indian gateways commonly forward by
GET; DoveSoft is asked to push by POST, a form or JSON, where it offers it,
and `/settings/deployment` says so. Both
formats are ASSUMED — DoveSoft documents neither push — so a payload missing
the fields that matter is never answered 200 and dropped: it is a **400** (a
**413** when too large) so DoveSoft retries, an `sms.dlr_unreadable` or
`sms.inbound_unreadable` audit row in `DOVESOFT_ORG_ID`'s org when it is
set, and an error line naming the fields it DID carry, never a value. `/audit` marks
`sms.inbound_unreadable` as an alarm: a text nobody could read may have been
a STOP. **A fault while recording is caught in the handler** (review round
4): either route answers **500** so DoveSoft retries, and the error line
names the fault's class only, because drizzle's message quotes every bound
parameter — the number and the words — and Next `console.error`s an
escaping error whole, past `redact()`. For a text whose words ask to stop
(`smsTextAsksToStop`, the one reading `recordInboundSms` acts on, exported
for this) the loud path runs too, under whoever the recorder said it was
filing the text under (review round 6): named first by the error the
recorder throws for a STOP whose holds or reply failed
(`SmsOptOutNotRecorded`, review round 7, its `filingUnder`; below), and
otherwise by its rolled-back line, which names the org and the contact
(`keepingRolledBackSmsOptOut` in the route's `webhook.ts`, matching only
`ROLLED_BACK_OPT_OUT_LINE`'s opening words, because the recorder also says
`OPT-OUT NOT RECORDED` of OTHER orgs' holders, which is no evidence of
whose the text was). Then `contact.opt_out_not_recorded` `{ channel:
'sms', why: 'record_failed' }` is written under that contact in THEIR org —
what `/compliance`, the digest and `/inbox` read — they are paused `opt-out
not recorded: reply <ISO> (record_failed)` over any earlier reason
(`pauseContactOverriding`, best-effort), and the AWAITED alarm names them,
with no message on file; every OTHER org the error names, where the
recorder has already taken the holders' loud path for the contacts holding
the number (below), gets an alarm of its own (`smsLostOptOutNotification`, review round
7 — those orgs heard nothing, and their holders kept a hold anyone could
lift). Only a fault before the recorder wrote anything or named anybody —
the duplicate check, the match, the narrowing, or a redelivered unplaced
STOP's look for its earlier rows — leaves the row with no subject in
`DOVESOFT_ORG_ID`'s org and the alarm with no touch and no contact, as for
a STOP from a number nobody holds (below). A STOP whose holds committed in
one org before another's faulted no longer reaches it, nor does a
redelivery's finishing (review round 7), because that row said nothing was
written and nobody paused. Round 5 took that path always, so a known
contact's STOP was alarmed as "nothing in the app holds the number" and
audited in an org that was not theirs, or nowhere. U+0000, which some SMPP
gateways decode GSM-7's `@` as and Postgres refuses in text, is stored as
U+FFFD in an inbound text and its message id and in a report's id and
reason, so such a push no longer fails on every retry — and
`recordInboundReply` does the same for every inbound reply on every channel
(§2, "A reply does four things"). A template is the exception, and refuses
one rather than replace it (review round 9, `/settings/templates` below).

- **A delivery report** (`messageid`/`msgid`, `errorstatus`/`status`,
  `errorreason`): `DELIVRD` and the spelled-out `Delivered` are
  `delivered` (`DELIVERED_WORDS`; a "Delivered" report was stored as
  `pending`); SMPP's final failures (`UNDELIV`, `EXPIRED`, `DELETED`,
  `REJECTD` and their spelled-out forms, `UNDELIVERABLE` included —
  `FAILED_WORDS`, a test pinning that no word is in both) are `failed`, with
  the reason or the word itself as `delivery_error`;
  anything else is `pending`, which claims nothing. `recordSmsDelivery`
  matches exactly one outbound SMS by `provider_id` and is idempotent and
  monotonic — `pending` only over nothing, a final word only over nothing or
  `pending`, and the first final word stands. It never moves `status`, writes
  no suppression and pauses nobody. The company page's Conversation panel
  prints it beside the status (`deliveryLine` in
  `apps/web/src/lib/delivery-view.ts`): "Delivery reported" beside
  `delivered_at`, which is when the REPORT reached this deployment — no time
  is read from a report (`readDlr`: the format is not public, and SMPP's
  zone-less `done date` would be a guess of five and a half hours), and
  DoveSoft batches and retries reports, so it can be hours after the handset
  took it; the line said "Delivered to the handset" and dated the delivery
  by its report (review round 4); "The operator has it; no final delivery
  report yet."; or
  "Not delivered" with the operator's reason and "A failed delivery is about
  the number on this attempt; it suppresses nobody." — because "not
  delivered" beside a person's name reads like a no. NULL — every email and
  LinkedIn message, and a text whose report never came — prints nothing
  rather than a guess. An id this system never sent is audited
  `sms.delivery_unmatched` in `DOVESOFT_ORG_ID`'s org (without one it is only
  returned for the route to log). Every report read is **200**, matched or
  not, because a retry would never match either.
- **A text back** (`mobile`/`from`/`sender`/`msisdn` and
  `message`/`text`/`sms`/`content`, plus an optional message id and time):
  the sender is read as E.164, with `+` added only to a bare `91` and a
  ten-digit mobile number starting 6–9 — twelve digits no Indian national
  number has — and no other country guessed; a time is taken only with a zone
  or as an epoch, and never in the future. `recordInboundSms` matches the
  number against contacts' phones across EVERY org, always, as a delivery
  report is matched by its id (review round 4): drafting and sending an SMS
  are not scoped to one org, and a STOP from a person another org texted,
  read only inside `DOVESOFT_ORG_ID`, was suppressed in the wrong org and
  left them on the list that texted them. `DOVESOFT_ORG_ID` is the FALLBACK,
  never a filter: where a text from a number no contact anywhere holds is
  filed, and its STOP suppressed — and nothing else. Several holders are
  narrowed by the evidence (`whoseText`, review round 5) to the one contact
  this system TEXTED at that number — a `sent` outbound SMS whose recipient
  reads as that E.164 — and to nobody when it texted none of them or two or
  more. No org is preferred (review round 6): every org's texts go out
  through the one DoveSoft account (`dueTouches` reads every org), so
  `DOVESOFT_ORG_ID` is no evidence of whose text was answered, and round 5's
  preference for its holder among texted ones in several orgs filed a reply
  on a guess. EXACTLY ONE contact, or exactly one texted: every OTHER
  contact holding the number, in any org — a twin row in the same org or
  another org's contact — is HELD first (below), BEFORE the reply is
  recorded, because once it is a redelivery is a duplicate that holds
  nobody; round 5 left the untexted holder live "by design", with an
  approved text still going to the number that had just replied. A STOP is
  then phone-suppressed in every OTHER org holding the number, each with
  its `sms.inbound_unmatched` row, still BEFORE the reply is recorded
  (review round 7): narrowing the match must not take the suppression away
  from an org it would have reached, and neither write needs the reply row
  — written after it, a reply that threw on every delivery left another
  org's holder with nothing but a hold a teammate could lift. Then it goes
  through `recordInboundReply`, the function an email reply goes through —
  an inbound `sms` touch, the pause, the cancel, the deal forward, and a
  STOP written as a PHONE suppression, source `reply`. When that suppression
  could not be written, the contact's same-org co-holders take the loud
  path with them (`why: 'suppression_failed'`), because the one row would
  have covered them too; when recording the STOP THREW, which rolled that
  row back with the reply, they take it with `why: 'record_failed'`, and the
  recorder throws `SmsOptOutNotRecorded` — `fault`, `filingUnder`,
  `optOutNotRecordedIn` and `heldIn`, the fault's CLASS and never a `cause`,
  so drizzle's message, which quotes the number and the words, cannot be
  logged through it — for the route's loud path above. **A holder takes the
  HOLDERS' loud path, never the asker's** (review round 8,
  `sharedNumberOptOutLost`): every holder of the number but the contact it
  was filed under — those twins, another org's holders where the
  suppression failed, every holder of a text filed under nobody, and every
  holder when the holds themselves fault (`holdOrSayWhy`) — is paused `opt-out
  not recorded: a text from a number they share, <ISO> (<why>)`
  (`sharedNumberOptOutReason`, which `pauseReasonClass` reads as
  `opt_out_not_recorded` by its opening words), and the org gets ONE
  `contact.opt_out_not_recorded` row, `{ channel: 'sms', why,
  sharedNumber: true, contacts, paused, kept?, holders: [ids] }`. **The hard
  hold writes over no pause, a reply's, the ordinary hold or an earlier hard
  hold, and nothing else** (review round 9, `holdHard`: each holder locked
  `FOR NO KEY UPDATE` in a transaction of its own, the reason it replaces
  named exactly in the UPDATE). It wrote over any earlier reason, through
  `pauseContactOverriding`: a holder's own unrecorded opt-out, or an
  erasure that had not finished, became this releasable shape, the retry
  eased it, and their email went. A holder's own unrecorded opt-out, an
  unfinished erasure, an unsubscribe's or a teammate's pause, and any other
  pause, now stands; the row still lists them,
  `paused` counts every holder held once it has run — written or kept, so a
  shortfall is still a write that failed — and `kept`, present when above
  zero, counts those whose own pause stood, while Resume refuses any pause
  of a holder the row lists until the number is recorded
  (`heldForUnrecordedSharedNumber`; §2, "The send path") — a row that
  governs them only until a later `contact.resumed` row of theirs spends it
  (review round 10). A kept holder is held by that row alone, appended after every hold
  has committed, so **when the row's append FAILS** (review round 10) each
  kept holder whose pause Resume would lift once the number is recorded —
  class `manual`, `unsubscribed` or `other` (`RESUMABLE_ONCE_RECORDED`) —
  gets the hard hold written over that pause after all, through `holdHard`'s
  `overResumable`, under the same `FOR NO KEY UPDATE` lock, replacing
  exactly the reason read; a kept own unrecorded opt-out or unfinished
  erasure stands, and the `OPT-OUT NOT RECORDED — follow up by hand` line
  carries `rowWritten: false`, `keptContactIds` and `heldHardInstead`. When
  the row is written nothing changes. The cost, stated: a teammate's or an
  unsubscribe's pause replaced this way loses its reason text on the
  contact row — it survives only in that pause's own audit row — so once
  the number is recorded and the hold eases to the ordinary one, the person
  pressing Resume sees the shared-number hold, not the original reason;
  that is the behaviour before round 9 for those classes, and only when
  the row could not be written. And a residual: a Resume that lands in the
  milliseconds between `holdHard`'s commit for a kept holder and the row's
  commit still lifts their pause while the number is unrecorded. That needs
  a person's click in that gap, and where their org's holds committed
  `holdEach` has already cancelled their queued, awaiting-approval and
  approved messages, so a text to the number needs a new draft and a new
  approval. The row's subject is
  the filed inbound touch where it is stored in that org and otherwise
  nothing — never a holder, as subject or `detail.contactId`. Round 7 gave
  each holder the asker's own pause and a row naming them, which `/inbox`
  reads as THEIR opt-out nobody recorded, however old: somebody who may have
  sent nothing was locked out on every channel, for good, by a fault
  DoveSoft's retry recovers from. So the hard hold lasts only while the
  number is unsuppressed. A delivery through `recordInboundSms` that finds
  the number's phone suppression in a holder's org — DoveSoft's retry, a
  redelivery's `finishRedelivered`, an unplaced redelivery, or any later
  text from the number, whatever it says (review round 9,
  `releaseWhereSuppressed`: only a STOP eased them before, so the "next
  text" `RESUME_SHARED_NUMBER` promised eased nobody unless it was another
  STOP) — replaces exactly that reason with the ordinary
  hold below, `sharedNumberHoldReason` (`releaseSharedNumberHolds`, the holders
  locked `FOR NO KEY UPDATE` by id, one transaction per org and best-effort:
  a fault leaves that org's holders held hard and says so), and the org's
  `sms.inbound_unmatched` row carries `released: n` — on a redelivery even
  in an org where only the ease happened, the filed org included
  (`filedUnder: 'another_contact'`, `redelivered: true`). And a number a
  person records by hand on `/suppressions` releases them with no further
  text: Resume refuses `isSharedNumberOptOutPause` (`RESUME_SHARED_NUMBER`,
  which says a text from a number they share asked to stop, and to record
  the number) only while no phone suppression in their org matches their
  phone, and then lifts it, `contact.resumed { pausedFor:
  'opt_out_not_recorded' }`. A holder whose own pause was kept is eased by
  no text: Resume refuses it `RESUME_SHARED_NUMBER_KEPT` while the number is
  unrecorded, and after that lifts it only where Resume lifts that pause at
  all — a teammate's or an unsubscribe's, never their own unrecorded
  opt-out or an erasure. The contact it was filed under keeps the
  asker's pause and row. `/audit` words the row as a number N contacts here
  hold, not treated as the one who asked, held until it is recorded, and
  says the next text DoveSoft delivers from the number after that makes it
  an ordinary hold that Resume lifts — "its retry of this one included,
  where the push carried a message id" for a row whose `why` is not
  `record_failed` (review round 10: a suppression that failed is answered
  200 for an id-less push, so no retry comes), and unqualified for `why:
  'record_failed'`, which the route answers 500 whatever the push carried —
  with `kept` as "K of them were already held by a pause of their own, which
  stands — no text changes it, and Resume lifts it, where Resume may, only
  once the number is recorded", and
  `/compliance` and the digest count one row per org where they counted one
  per holder — its company resolved only when its subject is the filed text
  stored in that org (`suppression_failed` in the filed org, or a
  redelivery's re-attempt there), and otherwise an unknown company. A filed
  text answers **200**; a filed STOP left unsuppressed anywhere — in the org
  it was filed under or another holding the number — answers **500**
  (review round 7), after the AWAITED `opt_out_not_recorded` alarms (below)
  and, when the filed contact's own suppression was written, the ordinary
  reply notice. It answered 200, so DoveSoft never retried, and the code
  that writes a missing suppression on a retry was never reached. That
  retry is a duplicate: it holds and pauses nobody, announces nothing, and
  writes only what is missing (`finishRedelivered`, below), alarmed and
  refused again where a write fails again. **That 500 is only for a push
  that carried a message id** (review round 8): the recorder knows a redelivery by its id
  alone, so the retry of a push with none, or a blank one, would be a new
  text — a second inbound row, a second reply notice, a second loud path,
  on every retry while the write kept failing. Such a push is answered
  **200** after the same awaited alarms, with an error line saying it
  carried no message id and that what is missing must be recorded by hand
  (`duplicate`, `orgs`, `alarm`, `messageId: false`); since review round 9
  so is a STOP filed under nobody whose retry would hold its holders again,
  or that has nowhere to be written (below — since review round 10 not one
  from a number no contact holds where `DOVESOFT_ORG_ID` is set), and an
  unreadable number is still a 400. Every org whose holders were held gets an
  `sms.inbound_unmatched` row (`why: 'ambiguous'`, `filedUnder:
  'another_org'|'another_contact'`, `contacts`, `paused`, `cancelledQueued`,
  and for a STOP `optOut` and `suppressed`), the filed org included when a
  twin there was held. None, or several and nobody narrowed: nothing is
  filed under a guessed person, and `sms.inbound_unmatched` is audited (ids
  and counts) in every org involved
  — but EVERY holder is held, one transaction per org, with the counts on
  the row; the first version paused nobody, so an approved text to any of
  them went on the next tick. **A hold** pauses `held: a text came from a
  number another contact also holds, <ISO>` (`sharedNumberHoldReason`,
  through `pauseContact`, so an existing pause keeps its reason — all but a
  reply's, below), which `pauseReasonClass` reads as `other` — Resume on
  `/contacts` lifts it, answering in `/inbox` does not — and refuses their
  queued, awaiting-approval and approved messages on every channel `paused`,
  a hold `REFUSALS_A_CORRECTION_RESOLVES` lets be drafted again once a
  person lifts it (review round 6). It paused `replied <ISO>`, which told a
  person to answer from `/inbox` a reply no row existed for, and cancelled
  `consent_revoked`, the recipient's own no, which enrolment read as a
  refusal for good of somebody who may have sent nothing. **A reply's own
  pause is the one a hold replaces** (review round 7): `holdEach` reads each
  holder's reason under a lock (`FOR NO KEY UPDATE`, by id, contact before
  touch) and replaces a `replied <ISO>` pause, named exactly in the UPDATE
  (`pauseContact`'s `replacing`, as `contactPauseByHand` does), because
  `/inbox` ends a reply's pause when the reply is answered, and a holder
  left with it was resumed by answering an old email while a person was
  still working out whose this text was. The lock is `FOR NO KEY UPDATE`
  since review round 8, never `FOR UPDATE`: every writer of `paused_reason`
  is an UPDATE of non-key columns, which takes that same lock, so the reasons
  are still read under one nobody can write past, while `FOR UPDATE` is the
  one row lock that also conflicts with the `FOR KEY SHARE` a foreign-key
  check takes — `approveDraft` re-pointing an email draft from one holder to
  another holds the draft and waits on the new holder's key share, while the
  hold, holding that holder, waits on the draft to cancel it: a deadlock
  (40P01, reproduced on Postgres 16), and for a STOP the loud path for every
  holder. `/audit` words each row by its
  writer — filed under nobody, under another contact here, under a contact
  in another org, or received again — and states the hold whenever either
  count is above zero ("1 of the 2 contacts holding the number was paused"),
  and a reply pause it replaced from the row's `replacedPauseFor: 'replied'`
  and `replacedPauses` ("the hold replaced the pause their reply had
  caused", or "… a reply had caused for N of them"). A fault while holding
  throws, and the route answers 500 so DoveSoft retries — for a STOP, never
  as the bare fault (review round 7). The holds are one transaction per org,
  so one org's may commit before the next one's faults, and the subject-less
  row the route then wrote said nothing was written and nobody paused, false
  of it: its holders kept a `held:` pause anyone could lift while nothing
  anywhere said their number had asked to stop. No suppression is written by
  then, so EVERY holder takes the holders' loud path (`why:
  'record_failed'`, one row per org) and the
  recorder throws `SmsOptOutNotRecorded` with `heldIn`, the orgs whose holds
  committed; the route pauses, audits and alarms the contact it was filing
  under, if any, alarms every other org, and files no subject-less row. And
  a STOP is not dropped, because a phone suppression is keyed by the number:
  it is written in every org whose contacts carry it, or in
  `DOVESOFT_ORG_ID`'s when no contact does, and the loud path runs where it
  cannot be — with no contact and no org named, nowhere, so it is a 500
  (a 200 for a push with no message id, below) logged `OPT-OUT NOT
  RECORDED` for a person to record by hand. The row's
  `suppressed` says whether the suppression was written — `false` in so many
  words for an unreadable number's STOP, which wrote no key before — and
  `/audit` claims one only for `suppressed: true`, marking an opt-out
  without it as an alarm; it called an unreadable
  number's STOP "put on the suppression list". An unreadable number is a **400** (the recorder has audited
  it and taken the loud path for a STOP); an unplaceable STOP whose
  suppression could not be written is a **500**, so DoveSoft retries it, and
  the `contact.opt_out_not_recorded` row and the error line record it and
  `/compliance` counts it — except, since review round 9, a push that
  carried no message id, answered **200** after the awaited alarms with an
  error line saying `messageId: false` and that what is missing must be
  recorded by hand: a text filed under nobody is known on a redelivery by
  a hash of its id alone (`messageHash`, below), so every retry of such a
  push held every holder again — undoing a teammate's Resume and
  cancelling drafts written since — and wrote another set of rows, the
  filed branch's reason (review round 8) restated. Only where that is what
  a retry would do (review round 10): the 200 is for `why: 'ambiguous'`,
  where holders exist and a retry re-holds them, and for `no_contact` with
  no `DOVESOFT_ORG_ID`, where a retry has nowhere to write. A no-id STOP
  from a number NO contact holds, with `DOVESOFT_ORG_ID` set, is a **500**
  again, so DoveSoft's retry writes the suppression in that org — the one
  write the 200 gave up on for good — and that retry holds and releases
  nobody (`retryOnlyRecords` in the route's `webhook.ts`). For both, the
  `opt_out_not_recorded` Slack alarm is AWAITED before the answer, as a
  filed STOP's is — **one per org where the suppression failed** (review
  round 6): the recorder reports each as `optOutNotRecordedIn`, `{ orgId,
  contactId | null }[]`, on both outcomes,
  and the route raises one each through `smsOptOutAlarms` — for a filed
  STOP, beside the filed contact's own alarm when their suppression failed
  too, or beside the ordinary reply notice when it was written. Another
  org's failure used to be
  folded into the filed contact's flag, so the one alarm named the org whose
  suppression had WORKED and the org that needed it heard nothing. Every
  alarm but the filed contact's names a contact holding the number in its
  org where there is one, with no message on file there, and links
  `/suppressions`, because that record holds the number. Only a number
  nobody holds (filed under `DOVESOFT_ORG_ID`) or one that could not be
  read has none, and its alarm goes with `touchId: null` and `contactId:
  null`: its message names no message or contact, says whose number it was
  is not known and that it may not be on the suppression list, tells the
  person to check `/suppressions` for the number in the provider's inbound
  log and record it there if it is missing, and that anybody holding it may
  already be paused (review round 7: a redelivered STOP has a message on
  file, and a recording that threw may have recorded part of it, so "no
  message is on file" and "nothing in the app holds the number" could be
  false) — the number, lead data, is not in the message — and links
  `/compliance`, never anything built from the number. It is filed
  under `DOVESOFT_ORG_ID`, the org the recorder audits such a push under,
  because the alarm's own `notification.*` audit row needs an org (its
  subject is `touch` with a NULL id); without one no alarm is raised and
  the error line says `alarm: 'not_raised_no_org'`. A delivery that fails
  again raises it again, as it writes the audit row again
  (`apps/web/test/dovesoft-webhook.test.ts`).
  Before, `SlackOptOutNotRecordedEvent` required a touch, and such a STOP
  reached a person only through an error line and an audit row. The
  subject-less `contact.opt_out_not_recorded` row reads on `/audit` "could
  not record an opt-out texted from a number no single contact holds (the
  number could not be read) — it is NOT on the suppression list; read the
  number from the provider's inbound log and record it by hand", where it
  said "a contact at an unknown company" — the bracket only for
  `unparseable_number`. A subject-less `why: 'record_failed'`, which only a
  fault before the recorder wrote anything or named anybody leaves now, has
  its own sentence (review round 5), because that writer never learned
  whose number it was, and "no single contact holds" sent the person
  following up to record a bare suppression and never pause anybody. Round
  7 reworded it to say only what is known, because a fault in the duplicate
  check on a redelivery, or in a redelivered unplaced STOP's look for its
  rows, comes after an earlier delivery recorded it, and the sentence said
  nothing was written and nobody paused: "could not record an opt-out
  texted in: recording the text failed, so whose number it was is not
  known, and part of it may already be recorded — by an earlier delivery,
  or by this one before it failed; it may not be on the suppression list.
  It was refused so DoveSoft retries, but until a retry is recorded, check
  /suppressions for the number in the provider's inbound log and record it
  there if it is missing — anybody holding the number may already be
  paused; pause whoever holds it and is not". That fault path's
  alarm is built by `smsUnplacedOptOutNotification` in the route's
  `notification.ts`.
  Deduplicated by the message id, and the partial unique index settles two
  deliveries that race. A text filed under nobody leaves no inbound row to
  find, so its `sms.inbound_unmatched` rows carry `messageHash` — a sha256
  of DoveSoft's message id, never the id, which leads to the number and the
  words in the provider's log — read back in SQL in the orgs involved; a
  redelivery that finds one holds nobody again, which would undo a
  teammate's resume and cancel drafts written since, and answers `why:
  'duplicate'`, writing for a STOP only a phone suppression still missing.
  A redelivered STOP filed under a contact writes any phone suppression
  still missing (`finishRedelivered`): in the OTHER orgs holding the
  number (review round 6), audited there `redelivered: true`, and since
  review round 7 in the org it was filed under, audited `suppression.added`
  with actor `system` beside the `contact.opt_out_not_recorded` the first
  delivery left — only when the redelivery's own insert wrote it (review
  round 8: `suppressPhone` returns `alreadyPresent`, and `suppressInEvery`
  carries it per org), because one a person or a parallel delivery wrote
  between the read and the insert was logged as System's add beside its
  writer's. The first delivery's 500 is what makes that retry come. A
  write that fails again takes the loud path again: `optOutNotRecorded` is
  true on a duplicate only then, and `suppressed` says whether the filed
  org holds the suppression after the redelivery (it was always false). A
  fault while finishing — or in a redelivered unplaced STOP's read of what
  is missing — is `SmsRedeliveryIncomplete` (`fault`, a class like the
  other's, `orgId` and `contactId`): a 500 with an error line naming the
  fault's class and the text's ids, and NO `contact.opt_out_not_recorded`
  row and NO alarm, because the STOP was recorded and the first delivery
  alarmed every org it could not suppress it in; it took the subject-less
  path, which said nothing had been written while the suppression and the
  pause stood. Both typed errors are exported from `@agency/db/queries`.
  Three residuals, stated: a stale redelivery can re-add a suppression a
  person removed in between, in the filed org now as in the others; after a
  STOP's recording throws, the other orgs' rows already say the text was
  filed under a contact in another organisation although the reply rolled
  back, and the retry that files it writes a second row there; and a holder
  held hard who later becomes the contact a text is filed under — the only
  one texted at the number — is not eased by that text, because the filed
  contact is left out of every release, though Resume lifts them once the
  number is recorded. A fourth is closed (review round 9): a shared
  number's holder is found, by a later delivery and by Resume alike,
  through their CURRENT phone, and one whose phone was edited after the
  STOP was eased by no delivery and refused by Resume for good — so
  `contactsUpdate` refuses that edit while they are held, paused or not
  (`shared_number_hold`, §2, "The send path"; round 10 narrowed it to
  paused contacts and review round 11 put it back) — but not over their own
  unrecorded opt-out or an unfinished erasure, which Resume never lifts
  (review round 12).

**`/settings/templates`** records registrations and registers nothing: add
one by hand, switch one off or on (idempotent, audited
`template.activated|deactivated`), or import the DLT portal's CSV export
(`templatesImportDltCsv`). The import reads header cells by alias — the
SmartPing portal's exact columns are not public, so `Template ID`, `Header`,
`Template Type`, `Template Content` and the other common spellings each
map to a field, and a new spelling is one string — takes only rows whose
status is approved (or has no status column), and ends every line in exactly
one of imported, already present, skipped or refused with its sentence; an
id stored with DIFFERENT words is refused, never overwritten. A file that is
not UTF-8 is refused whole — a body through a lossy decode would never match
the operator's copy — as is one with no header, a required column missing
or an unclosed quote. A U+0000 in any field a template stores — the body,
the DLT id or WhatsApp name, the header or sender, the category, the name
and the language — is refused with a sentence (`nulRefusal` in
`packages/db/src/templates.ts`, review round 9), never replaced with U+FFFD
as an inbound text's is, because a template is the registered text exactly
and words with a character replaced are words nobody registered; the name
has a refusal of its own for it, `bad_name` (400), and an import reports
such a line as refused. It failed the INSERT, and the fault reached the
route whole. Both POST routes now catch a database fault
(`templateCreateAnswer` and `templateImportAnswer` in
`apps/web/src/app/api/templates/outcome.ts`) and answer 500 with a
sentence, logging the fault's class only, because drizzle's message lists
the template's words and ids; an import's sentence says lines before the
fault may already be recorded and that importing the same file again is
safe. The routes are gated `campaigns:read` (list) and
`campaigns:write` (add, switch, import). `/settings/deployment` names the
DoveSoft variables and prints the two webhook URLs, built from `AUTH_URL` —
never a Host header — with `<DOVESOFT_WEBHOOK_SECRET>` where the token goes.

**Not built, and why.** Calls (OBD, click-to-call) and WhatsApp over
DoveSoft: DoveSoft publishes no API documentation for either, and a guessed
field name in a path that dials a person or decides an opt-out is the one
thing this design will not do. `message_templates` and `TEMPLATE_CHANNELS`
already carry WhatsApp, the inbox says WhatsApp sending is not available,
and no provider exists. **Three assumptions, stated rather than hidden
(§13):** the DLR and inbound push formats (the alias lists above — fix one
in a line once DoveSoft's account manager confirms it); the response body,
documented only as "carries `messageid`" (`messageIdFrom` takes a top-level
`messageid` or the first one found breadth-first three levels down, exact
key, and fails loudly otherwise); and the `mobiles` format — the E.164 digits
WITHOUT the `+` (country code first, `dovesoftMobile`), the common Indian
gateway form, the one thing to confirm with DoveSoft before a real send.
Also open: the stale-evidence step judges an SMS draft by its company's
scan although a template may quote no scan (the composer's dry run shows
that refusal as it is); a daylight-saving change between a deferral and
its retry can send a promotional SMS late by the size of the change or
defer it once more (never early), and one to a +91 number in Los Angeles
deferred across the switch to summer time is then refused
`band_never_opens`, because the half hour its band had in winter is gone;
the email opt-out reader still misses decoration at the ends (§2, "A reply
does four things"); `smsOptOut` is still roughly quadratic on a long run of
whitespace or punctuation, about 100–250 ms on a 16 KB body, from
`SMS_DECORATION_ENDS`' end-anchored alternative and `SMS_CLAUSE_BREAK`'s
spaced dash — round 7's capital-STOP reading walks the end in linear time,
round 8's question reading splits the clause once and reads a bounded
number of words, and neither adds anything measurable, and both routes sit behind the webhook
secret; and a GET push logs a text's number and words at the
platform, by design, until DoveSoft pushes by POST. The two labels round 4
left lagging the band are current: `/settings/templates`' hint for a
promotional template (`CATEGORY_HINT` in
`apps/web/src/app/settings/templates/words.ts`) reads "Held outside
10:00–21:00 where the recipient is — and outside 10:00–21:00 India time as
well for an Indian (+91) number — and the operator drops it to a DND
number", and `unknown_timezone`'s "no timezone on the contact" is true
again of everything left under it, now the band has its own code.

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
no_scan | rescore`), the company page's button says why before it is
pressed, and the fix is a re-scan. `rescore` ("scored under a different
profile — re-scan") is raised when the scan's score names another ICP
profile, or a signal the active ICP scores was recorded `scored = false` on
that scan — a promotion — because the active ICP's walk would otherwise list
a signal the scanner DID observe to the buyer as not assessed. So
`ProposalInput.profiles` is required, and `generateProposal` passes every
finding with its `scored` flag and lets core filter. `proposals.scan_id` is
`RESTRICT`, so the evidence a sent
proposal quotes cannot be deleted from under it. Effort is rounded to halves
ONCE, at the end — rounding each increment compounded the error. Accepting a
proposal is what closes the deal `won`, through `setDealStage` (it stamps
`closed_at`; `advanceDeal` only moves the stage). A status changes only over
the status the caller READ (`setProposalStatus`'s `from`, in the UPDATE's
predicate; review round 3): the team route read and then wrote, so a
person's click could overwrite a buyer's acceptance through the share link
that landed in between. No match is a 409 saying what it became; only
`shareAccept`, which already holds the row `FOR UPDATE`, omits it.

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
a human to fix. Rate limiting belongs at the edge — on Vercel, the WAF rule
DEPLOYING.md's public-surface section asks for — like `/api/health`.

**Deals have owners.** `setDealOwner` writes `deals.owner_user_id`, the board's
card sets it, and the change is a `deal.updated` audit row naming who. (An
earlier version of this file listed ownership as not built; it was built
before 0018.)

**Rotting means "untouched", not "in stage".** It is measured from
`updated_at`, which every change writes — a move, a next action, an owner, a
due date — so the honest label is "untouched for N days", and
`deals.stage_entered_at` was rejected: it would have been a second clock that
disagreed with the first. **`next_action_at` has a writer**: `PATCH
/api/deals/[id]/next-action` (`deals:write`), one UPDATE whose self-join reads
the value it replaces, plus the audit row `deal.next_action_set { companyId,
from, to }`, in one transaction. A date on a closed deal is a 409; clearing is
always allowed. A due date set from the board is the END of the chosen day in
the setter's zone, and "due today, or overdue" is `next_action_at <= now +
24h`, which is today in any zone for a board-set date — the server does not
know the viewer's.

**`advanceDeal` audits its own moves.** Every automatic creation and advance
writes `deal.created`/`deal.advanced` `{ companyId, from, to }`, actor
`system` unless the caller names one, with the caller's `db` — so inside a
transaction it commits or rolls back with the move. Before, a send, a reply,
a booking or a generated proposal recorded the move only inside its own
action, none of which says the stage the deal LEFT, so analytics could not
count it. `POST /api/deals` still writes its own `{ companyId, stage }` row
beside advanceDeal's; `analyticsTransitions` leaves those out in SQL (they
have no `to`), so one move is neither counted twice nor reported unreadable.
Still NOT recorded as deal rows: a stage set by the agent's `update_deal`
(audited as `agent.update_deal` with no `from`), a proposal accepted as won,
and every automatic move made before this change. **Forward-only and
open-only are in the UPDATE's own WHERE** (review round 3): the rank check
was a read, and under READ COMMITTED a booking or a person closing the deal
could commit between it and `UPDATE … WHERE id = …`, so a move could be
knocked back, a closed deal given an open stage, and `deal.advanced` written
with a stale `from` even when nothing changed. Now a CTE locks the row
`FOR UPDATE` only while it is still open and still behind `to`, `from` is
the stage that UPDATE actually replaced, and a row that no longer matches
asks again from the top — `unchanged`, or a new open deal if it was closed
meanwhile — with nothing audited for a move that did not happen.

**Analytics are lower bounds and say so.** `/pipeline/analytics` computes win
rate and velocity (median days from creation to won) from `deals`, so those
are exact; conversion and time in stage come from the recorded moves, and time
in stage counts only stays whose arrival AND departure were both recorded.
Every figure is shown beside its denominator, and below five it reads
"insufficient data (< 5)".

**A meeting has an outcome, once it has started.** `meetings.outcome` is
`held`, `no_show` or `rescheduled`, and `starts_at <= now` sits in the one
UPDATE beside `cancelled_at IS NULL`. A no-show does not move the deal. Held
and no-show can correct each other, and each correction writes its own
`meeting.outcome_recorded`; `rescheduled` cannot be corrected —
`setMeetingOutcome` refuses it `already_rescheduled` (409 from `PATCH
/api/meetings/[id]`), and the page offers no Held/No-show on it, only a line
saying to record the outcome on the new meeting — because "held" over
"rescheduled" made the meeting reschedulable again, and a second reschedule
left the first replacement on the books with nothing pointing at it.
`rescheduleMeeting` marks the old meeting
`rescheduled` and records the new one through `createMeeting` in ONE
transaction — a "rescheduled" that names no new meeting would be a claim with
no evidence — and the replacement keeps the original's source, contact,
title, length, notes and review flag; the two are linked only through audit
rows (`rescheduledTo`, `rescheduledFrom`), read by `meetingRescheduleLinks`.
`cancelMeeting` refuses a meeting whose outcome is recorded, because held and
cancelled are opposite facts.

**An `.ics` file is a download for the team member's own calendar**, not an
invitation: `METHOD:PUBLISH`, no ATTENDEE, no ORGANIZER, and it says "Nobody
is invited by it." It carries nothing from notes or `external_ref` and names
no contact; a booking-page title is rebuilt from the company, because the
system writes it from the visitor's name, and an `.inbound` company appears as
"an inbound lead".

**A proposal can be printed and downloaded; it still cannot be sent from
here.** `/proposals/[id]/print` renders the STORED document through
`<ProposalDocument audience="team">` with no Shell, and prints the stale
banner, taken from `scans.ran_at`. `GET /api/proposals/[id]/markdown`
(`deals:read`) returns the buyer's content — no score, tier or per-item weight
— plus the stale banner, because Markdown is the form most likely to be pasted
into a mail and removing the banner should take a deliberate edit; it refuses
a DRAFT whose evidence is stale (409), and one whose scan a newer successful
scan has superseded (409, `reason: 'superseded'`), because only the latest
scan is quoted; the print view, the proposal page and its download links show
a superseded banner or note (`supersededBannerText`). Both write `proposal.exported`, and
both read the stale threshold through `readIcp` (`lib/company-list.ts`),
which delegates to `staleAfterDaysOf` (§1), so an unparseable or
non-positive `stale_after_days` falls back to the default rather than making
`isStale` throw.
`ProposalDocument` carries an `audience`: the buyer copy omits score, tier,
weights and the word "stale"; both keep the "not the case here (…)" and "not
assessed" sentences verbatim. Every copy says "Prepared by <the org's name>"
— `orgs.name`, through `orgIdentity` on `/proposals/[id]` as the print view
and the buyer page already read it; the team view used to print the active
ICP's label, a scoring profile's name, there (§2, "The settings pages and
the dashboard").

**A share link is the proposal's own document behind an unguessable,
revocable token; accepting it is the same `setProposalStatus` a person
clicks.** A link is minted only from `sent` — never an implicit draft → sent,
because marking a proposal sent is the human act §2.4 means — and only while
the evidence is fresh and current. `expires_at` is capped at `scan.ran_at +
stale_after_days`, and the read and the accept re-derive `isStale(ran_at)`,
because the threshold can be lowered after a link is minted; the buyer is
then told "being re-verified", never "stale". Fresh is not enough on its
own: once the company has a newer SUCCESSFUL scan, the one the proposal
quotes is superseded — the newer one may say a priced gap is closed — so
mint refuses `superseded` ("A newer scan exists — regenerate the proposal"),
and the read and the accept treat a superseded scan as stale (the buyer is
told it is being re-verified, no view is counted, accept is 410). An
unreachable newer scan supersedes nothing. Supersession is compared in SQL
against the STORED `ran_at` of the proposal's own scan, and that scan is
excluded by id: `ran_at` is `DEFAULT now()`, stored to the microsecond, and
a comparison against the same instant read back as a millisecond `Date`
matched the proposal's own scan — on real Postgres every proposal was
superseded by itself, no link could be minted, and every live one read
"being re-verified". `shareEvidenceSuperseded` lets the proposal page's
Create button say why before it is pressed — and is what the print view,
the proposal page's warning ("Regenerate it before marking it sent") and the
download links read. `shareCreateBlocked`
(`apps/web/src/components/pipeline/proposal-share-copy.ts`) says it in the
order the route would refuse, with one exception: a DRAFT whose evidence is
stale or superseded hears that BEFORE "Mark the proposal as sent first",
because `shareMint` refuses a sent proposal over either and nothing makes a
scan current again — a re-scan writes a NEW scan, which supersedes this one
— so the old order's advice could only end in a second refusal over a
proposal now marked sent. Stale comes before superseded, the order the route
uses for a sent proposal. A stale draft hears "Not while the evidence under
this proposal is stale … This draft could not be linked even once marked
sent: re-scan the company, generate a fresh proposal, mark that one sent,
and link it"; a superseded one "A newer scan exists — regenerate the
proposal … generate a fresh proposal from the latest scan, mark that one
sent, and link it"; only a fresh draft is told to mark it sent first. Round
3 moved the superseded draft and left the stale one hearing "mark it sent
first" (review round 4; `proposal-buyer-view.test.ts` and
`proposal-share-copy.test.ts` pin the order). Each
link in the team's
list says what its buyer sees: `stale — the buyer sees “being re-verified”`
or `superseded — the buyer sees “being re-verified”`, never `live` for a
link whose buyer cannot accept. A view is a count and two timestamps. The
public page returns 404 for an unknown, revoked or expired token alike (a
page cannot answer 410; the accept route does).

**Notes and tasks are internal state with no outbound side.** Kickoff and
renewal templates are created by a click, never by a stage change — the board
should not fill with work nobody asked for — and are refused without a won
deal or while a set of the same kind is still open, in one transaction under
`pg_advisory_xact_lock`, so a double click makes one set on real Postgres.
`packages/core/test/documents-never-read-notes.test.ts` keeps notes out of the
proposal and the brief; its predicate is the notes MODULE and TABLE, not the
word "notes" (a meeting has its own notes column), and it runs over
fabricated leaks so it is shown to be able to fail. Lengths count code points,
as Postgres `length()` does. "Due today" in `tasksCounts` is the next 24 hours,
because the org has no zone. A `linkedin_send` task cannot be ticked from
`/tasks` (409): ticking it would claim a message went that no rule checked.

**Not built:** calendar invitations (a meeting recorded here moves the deal;
the invite goes from a person's calendar or the calendar connector, and
`book_meeting`'s summary says so — an `.ics` download is not an invitation),
and a proposal PDF or e-mail send (the document is the JSON; sending anything
is Phase 4's single path — a share link is not a send).

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
same code a deployment runs. The agent worker has since been split the same
way: `apps/agent/src/worker.ts` exports `startWorker({ env, log })`,
whose memoised `stop(signal)` never exits the process, and `index.ts` stays
the entry — the image's `CMD`, the package scripts, `tools/run-worker.sh` and
`tools/smoke-agent.ts` all name it — reading the environment and owning the
signals and the exit code (`apps/agent/test/worker.test.ts`). The comments
that named `index.ts` for wiring that moved — `tools/run-worker.sh`,
`boot/heartbeat.ts`, `outreach/options.ts`, and `runtime/options.ts`, which
now says `loadEnv` refuses the local login in production — name
`worker.ts` or `loadEnv` now, and so do the two that said `index.ts` builds
the inbox (`apps/agent/src/notify.ts`, beside `optOutAlarmFromEnvironment`,
and the `optOutAlarm` field's comment in `apps/agent/src/outreach/inbox.ts`),
which name `startWorker` in `worker.ts` (review round 4).

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
turns are sent — not the system events. The worker calls `classify_reply`
(`apps/agent/src/outreach/classify.ts`) and `draft_outreach`
(`apps/agent/src/outreach/draft.ts`) the same way, beside the deterministic
answer; the model's reply kind is then WRITTEN through the inbox's
reclassify path (`replyReclassifyIfStill`), so every guard a person meets
applies to it and a kind a person set meanwhile stands (§2, "The opt-out
reader runs first"). `summarise_findings` has its task key and no caller yet; wiring it is
adding an `attemptText` call beside the deterministic answer that already
exists, never in place of it. (The agent TOOL named `classify_reply` is a
different thing: it records a kind a model or a person chose, and calls no
model itself.)

### The compliance page and the audit log

**The compliance page COUNTS ROWS and re-derives no rule.** `/compliance`
reads `complianceSummary()` in `packages/db/src/compliance.ts` — the same read
`get_compliance_summary` makes, so the page and the tool cannot disagree.
Quiet-hours breaches are deliberately NOT recomputed: today's window and zone
applied to yesterday's send is not an observation, so what is counted is the
send path's own `refusal_code = 'quiet_hours'`. Approvals decided after expiry
are labelled a clean expiry, informational, against today's rows — never a
breach, because `decideApproval` allows it on purpose (§1). Freshness comes
from the latest scan's `ran_at` through `isStale`, and the page shows how many
stale companies `findings.stale` still calls fresh. The threshold is read
through `readIcp` (`lib/company-list.ts`), like the proposal print view and
the Markdown export, and `readIcp` delegates to `staleAfterDaysOf`, the
helper `get_compliance_summary` and every other reader take (§1): an
unparseable or non-positive `stale_after_days` falls back to the default
instead of making `isStale` throw, and the page says so in a note.

The must-be-zero checks: `callsThatDidNotDisclose()`, which leads the page;
opted-out replies and calls with no matching suppression row today (keys from
the send path's own `suppressionKeysFor`; an unreadable key is listed, never
read as clear), beside the count of every audit row a writer leaves when it
KNEW an opt-out failed to store — `DIGEST_OPT_OUT_FAILURES`
(`contact.opt_out_not_recorded`, `unsubscribe.not_recorded`,
`contact.erasure_failed`), imported from `digest.ts` so the page, the
dashboard, the tool and the digest cannot disagree, each row naming its path
and its company resolved through the contact, the touch or
`detail.contactId` (counting the first alone reported 0 over a failed
unsubscribe or erasure; and since review round 8 a colleague's stop whose
sender is a contact here leaves 1 + N rows — one about the reply, one under
each sender contact — while a shared number's holders leave one per org,
not one per holder, whose company resolves only through the filed text
where it is stored in that org: §2, "SMS through DoveSoft");
voice/SMS/WhatsApp touches that WENT OUT with no
granted consent row today, with the send path's own refusals counted apart as
"stopped by the send path"; and every outbound row not yet sent
(`COMPLIANCE_UNSENT_STATUSES`: `awaiting_approval`, `approved`, `queued`,
`sending`) on stale or missing evidence, with its reason in `byWhy`:
`stale` or `no_evidence` (the company's latest successful scan is stale, or
there is none), `rescanned_since` — the latest scan is fresh, but the
words were written from an older one that is stale now — or `superseded`:
the words were written from a scan still inside its deadline, but a newer
successful scan of the company exists, which the send path refuses
`stale_evidence` too (§1). Aged AND superseded is `rescanned_since`, the
plainer of two true reasons, as the sender words it. Each of the last two
was missed in its turn, so the page could say zero while a blocked draft sat
in `/approvals`. `superseded` is asked in the same SELECT the way
`evidenceState` asks it: the latest `ok` scan at or before the words, then a
newer `ok` scan compared against its STORED `ran_at` with that scan excluded
by id — never a millisecond `Date` read back and compared, which matched the
scan itself (`packages/db/test/compliance-stale-evidence.test.ts` checks a
scan stored to the microsecond never supersedes itself, and that a newer
FAILED scan supersedes nothing). Rows are tagged by status (`byStatus`, `unsent` beside
`awaiting`), and each carries `writtenFromScanAt` — the scan the send path
judges the words by, found in SQL against the stored values as
`sendFactsFor` finds it, null for an answer to a reply — and
`refusedAtSending`. That scan is looked up by
`coalesce(contacts.company_id, touches.company_id)`: it went through the
contact alone, so every `queue_touch` draft — `contact_id` NULL until a
person picks the recipient — read `writtenFrom` NULL and `refusedAtSending`
false, and the page and `get_compliance_summary` misreported how the send
path treats the agent's drafts (review round 3). The listed rows split into `refusedAtSending` (the send
path refuses them `stale_evidence`, whoever approved them, superseded ones
included; the fix is a new draft from a fresh, latest scan — a re-scan
first only where the scan aged), `notJudgedAtSending` (no successful scan behind
the words, or an answer to a reply, which go as written unless another rule
stops them — answers are counted here now, with no card of their own) and,
of those, `notJudgedNoFurtherLook`: the approved, queued and sending ones,
which go with nobody looking again. Refusing is the send path's; this is the
reporting half. The page words a superseded row "written from the scan of
<when>, still fresh; superseded by the newer scan of <when>", and its rule
paragraph names supersession beside ageing; `get_compliance_summary` counts
the superseded rows apart from the stale ones, because "a scan that is
stale now" is false of them. The card that counts them reads "…of which
refused at sending (stale or superseded evidence) — draft again from a
current scan", a fix true of both; it said "(stale evidence) — re-scan, then
draft again", which a superseded row does not need (review round 4). The auto-send check prints its predicate and its zero, and its
test runs the same predicate over rows that would match. Every zero says
"none recorded" and names the recorder that is absent — no worker, no reply
path, no `UNSUBSCRIBE_SECRET`, a voice service the page cannot see. Whether a
WORKER records anything is read from the heartbeat (`workerStatus()`, through
`apps/web/src/app/compliance/recorders.ts`), not from `deployment().worker`:
the documented production shape is `AGENT_URL` unset with a worker on Fly
that sends and reads a mailbox, and the page used to tell that deployment
nothing sends. A worker sending only SMS counts as sending too:
`workerSends` (`lib/dashboard-view.ts`, which the recorders import) reads
the row's `sms` beside its `outreach`, the mailbox, so a worker with
DoveSoft and no SMTP is no longer "not sending" here or on the dashboard,
and the replies recorder says of such a worker "The worker is running with
email outreach switched off" — its outreach is not off, only its mailbox —
the dashboard's own words for the same heartbeat (`notReadingBecause`;
review round 5; `workerSendsSms`).
And where `deployment().smsInbound` holds, the replies recorder says no
EMAIL webhook is configured and that texts, a STOP included, still arrive
through DoveSoft's webhook. Configuration speaks only when the heartbeat cannot be read,
and then as configuration ("No worker is configured on this deployment,
and the heartbeat … could not be read"). Pages with no heartbeat in reach —
`/contacts`, `/inbox`, `/approvals`, `/campaigns` and the inbox reply route
— now word their notes as configuration and point at
`/settings/deployment` (review round 3). `/contacts`' pause note says "As
configured, this deployment pauses nobody on an email reply — a worker
running elsewhere can, and a text reply through DoveSoft's webhook does
where that is set up"; it said nobody was paused by a reply "only by hand",
false on both counts. `COMPLIANCE_REFUSAL_HUMAN_CAN_RESOLVE` restates `decideSend`'s
`humanCanResolve` per code (a row stores the code, not the decision), typed
`Record<SendRefusalCode, boolean>` so a new code fails the build, and
`compliance.test.ts` drives `decideSend` into every code and asserts they
agree.

**The audit log has a reader.** `/audit` is keyset-paged on `(created_at,
id)`, newest first, 100 a page. The cursor comparison reads the cursor row's
STORED `created_at` by id, because a JS `Date` holds milliseconds and
`timestamptz` microseconds: a cursor built from the `Date` skipped rows
written in the same millisecond. Filters: an action family (an escaped LIKE —
`_` is a wildcard and nearly every action has one), an actor, a subject type,
a subject id. Sentences come from `apps/web/src/lib/audit-copy.ts`, which is
pure and reads `detail` only through `detailValue()`, refusing `SENSITIVE_KEY`
keys and `SENSITIVE_VALUE` strings; the raw row sits behind `<details>`,
through `redact()`, and an unknown action is shown as its raw name.

**Every action a writer produces has a sentence, and a test reads the tree to
keep it so.** `apps/web/test/audit-copy.test.ts` scans every `src/` under
`apps/` and `packages/` for `action:` and `audit('…')` literals — a ternary
on the lines after `action:` included — and fails for an action with no
sentence or no detail shape in its `WRITTEN` map, for a templated action whose
expansions nobody listed, and for a `WRITTEN` entry nothing writes. A
convention did this job before and failed: features built in parallel wrote
seven actions from files that were not `audit-copy.ts`, and `/audit` showed
each as a raw name. `isAlarm` highlights an opt-out that was not recorded, a
call with no AI disclosure, a digest whose worker-silent alert reached
nobody, and (0019) an inbound text nobody could read, which may have been a
STOP, and an `sms.inbound_unmatched` STOP whose row does not say
`suppressed: true`. The page's own notes say what the log does not show the way one might
expect: an automatic deal move is a line of its own, from System, beside the
`send.sent`, `contact.replied`, `meeting.booked` or `proposal.generated` line
that caused it (the notes used to say it had none, after `advanceDeal`
started writing one — §2, "The pipeline"), and three moves still have no
deal line; an approval decision is written twice (the web route and the
worker); scans are audited only when the cron or the agent ran them; and
suppression changes before 0018 were never written at all (§4).

### Notifications and the heartbeat

**Slack is one seam, and it carries ids.** The `NotificationEvent` union in
`lib/slack-message.ts` names every kind — `reply`, `booking`, `deal_closed`,
`proposal_accepted`, `opt_out_not_recorded`, `digest`, `worker_silent`,
`campaign_paused` — and the content rule is ids, a public domain, a kind and a
deep link: never a body, a name, an address, a phone number, a note or a
chosen time. A free-mail lead's `<address>.inbound` row reaches the channel in
NO field, the link included, because Slack unfurls and logs URLs; such a
message links to `/inbox`, `/pipeline` or an id-based page, and
`slack-message.test.ts` asserts no payload contains `.inbound`. The
`opt_out_not_recorded` member is core's `SlackOptOutNotRecordedEvent`, and
that message — with the 4,000-character cut every message gets — is built in
`packages/core/src/slack-payload.ts`, because the worker posts it too and a
person in the channel must not be able to tell which process noticed. Its
`touchId` is `string | null`, like `contactId` beside it. With neither — an
SMS STOP from a number no contact holds or that could not be read, or one
whose recording threw before the recorder wrote anything or named anybody
(§2, "SMS through DoveSoft") — the message reads "no message or contact
named", says whose number it was is not known here and that it may not be
on the suppression list, tells the person to check the Suppressions page
for the number in the provider's inbound log and record it there if it is
missing, and that anybody holding it may already be paused, and links
`/compliance` where a filed alarm links `/suppressions`. It said no message
was on file and nothing in the app held the number, which a redelivered
STOP, or a recording that threw after writing part of it, made false
(review round 7). With a contact and no touch — an email stop whose
recording threw, on either webhook or the worker's IMAP inbox, matched by
its sender's address alone; an SMS STOP whose recording threw after the
recorder named its contact; and, since review round 6, an SMS STOP whose
suppression failed in an org where a contact holds the number — another
org than the filed contact's, or any when it was filed under nobody — or,
since round 7, whose recording threw after the recorder had taken the loud
path there (`SmsOptOutNotRecorded`'s `optOutNotRecordedIn`), it
says no message is on file, names a contact there and
links `/suppressions`, because the contact's record holds the address or
the number. With `fromIsContact: false` — a colleague's stop filed under
the contact our message went to (review round 7; §2, "The opt-out reader
runs first"), on the committed path or one whose recording threw — it reads
"touch <id> · sent by somebody other than the contact" (or "no message on
file" for none) and "The reply came from another address than the contact
that message went to, so record THAT address, never the contact’s: read it
from the mail itself, check the Suppressions page for it, and record it
there if it is missing", and links `/suppressions`: without it the alarm
named the contact, and the person following up would suppress the wrong
address. The field is a boolean, never the address, and an event that does
not set it posts the bytes it always did. A filed alarm's bytes are
unchanged. **The ordinary `reply` notice says whose words they were too**
(review round 8): its event carries an optional `fromIsContact?: false`,
which `replyNotification` sets only when the outcome says false, and the
message then reads "Reply from <domain> — somebody else on the thread asked
to stop." (or "<kind>, from somebody else on the thread"), for a suppressed
stop that the sender's address is on the list and the contact it was filed
under did not ask to stop — "do not suppress them" — and "touch <id> ·
filed under contact <id> · sent by somebody other than the contact": "they
asked to stop" beside the contact's id pointed a person at somebody who
never asked. A contact's own reply posts the bytes it always did, and
DoveSoft's reply notice is untouched. The webhook URL is a bearer credential `redact()` cannot see, so
it is never logged and a failure is reported by error NAME or Slack's short
token. One attempt, 3 s, no retry, and an audit row
`notification.sent|failed` with actor `system`.

Routes call `notify()` inside `after()`, after the write, wrapped in
try/catch — Next `console.error`s an escaping Error whole, past `redact()` —
and the deal and proposal routes read the company domain inside that
callback, so a failed read cannot 500 a move that is already committed. A
duplicate inbound delivery announces nothing; accepting a proposal closes the
deal won inside `setProposalStatus`, and that close is not announced again.
`opt_out_not_recorded` is the exception: it is AWAITED — on the unsubscribe
and erasure paths, which are already answering 500; on the two email inbound
routes, which answer 200 because a retry would be a duplicate and record
nothing more — except for a stop whose recording threw, which they answer
500 so the provider retries (since round 5: §2, "The Resend inbound route
is a READER"); on DoveSoft's `/api/inbound/dovesoft/sms`, which answers 500
for every STOP left unsuppressed anywhere — one whose recording threw (since
review round 4), one filed under nobody (400 for an unreadable number), and
since review round 7 one filed under a contact, because a 200 there meant
no retry ever came and the duplicate's write of the missing suppression
was never reached — but only when the push carried a message id (since
review round 8 for a STOP filed under a contact, and review round 9 for one
filed under nobody), because without one its retry is recorded as a new
text, so such a push is answered 200 after the same alarms — except, since
review round 10, a STOP from a number no contact holds where
`DOVESOFT_ORG_ID` is set, which is a 500 whatever the push carried, because
its retry holds nobody and only writes the suppression — and raises the
alarm again on each delivery that fails again, while a redelivery whose
finishing faulted is a 500 with no alarm;
and on the worker's IMAP path, before the reply triage for a stop whose
suppression failed (§2, "The opt-out reader runs first"), and on the first
failure of a stop whose recording threw (review round 6) — the same alarm
through the same `optOutAlarm`, still the worker's one Slack path.
**`campaign_paused` comes from the digest cron**, because the pause happens
in the worker, which has no Slack path for it: `digestOnce` posts one
notice for each `campaign.auto_paused` row read after the previous run's
mark, at most `DIGEST_MAX_PAUSE_NOTICES` (3), and the `cron.digest` row
records `campaignPauses { found, posted, readThrough }`. `readThrough` is
`{ at, id }`: the stored `created_at` of the last pause read, as
microsecond UTC ISO TEXT — never a JS `Date`, the /audit cursor's trap —
and its id; the next run reads strictly after it, the marked row's
timestamp compared in SQL by id. The window's lower end used to be the
previous `cron.digest` row's own `created_at`, Postgres `now()` on another
clock from the `now` the run had read up to, so a pause stamped between the
two was read by neither run, or by both. The previous row is looked for
across `DIGEST_MARK_LOOKBACK_DAYS` (7), not 24 hours, because Vercel fires a
cron anywhere inside its minute — on about half of days the previous run is
a little over a day old — and a failed day makes it two; a run that reads
nothing carries the mark forward; with no mark, a run reads the 24-hour
lookback, started no earlier than a mark-less previous row, and a run that
reads nothing and had no mark records `{ at: <its now>, id: null }`. Past
the cap the digest says so — "Campaign pauses: N announced below, and M
more campaigns paused themselves — see <origin>/campaigns" — and the
`/audit` sentence for `cron.digest` says how many pauses got no notice of
their own (`found > posted`: past the cap, a refused post, or no Slack). The
worker still logs a warn line per pause. **Not built:** retries, a per-org
webhook, and a worker-side notifier for anything but the opt-out alarm.

**The alert that the worker is silent cannot come from the worker.** The daily
digest cron reads `worker_heartbeats` and posts a separate `worker_silent`
message, after the digest and any `campaign_paused` notices so it is still
the newest message, when the newest heartbeat is older than the threshold
that row earns (`heartbeatSilentAfter`: max(600 s, three of the worker's own
ticks)) — whether or not `AGENT_URL` is set, because a row beats
configuration — or when there is no row and a worker is configured. It used
to require `AGENT_URL`, and the documented production shape (Vercel without
it, the worker on Fly) is exactly the one where the digest's own line said
"Worker: SILENT" while the alert was recorded `not_needed`; `workerSilent`
now agrees with `heartbeatReport` on every cell, retired included. **A row
does not beat configuration forever, though.** Only a running worker's own
write prunes the table, so `./tools/run-worker.sh` run once against
production and closed left a row that raised the alert every morning, for
good — the daily noise that teaches a channel to ignore the one alert that
matters. Where no worker is configured (`deployment().worker` false), a
silent row older than `HEARTBEAT_RETIRED_AFTER_DAYS` (7,
`packages/db/src/heartbeat-read.ts`, the one place the number lives) is
RETIRED: no `worker_silent` alert, a digest
line "retired — last seen <YYYY-MM-DD>; no worker is configured, so nothing
is sending or reading replies", and `worker: 'retired'`, `workerAlert:
'not_needed'` on the `cron.digest` row. A configured worker is silent
however long it stays so, and an unconfigured row between the silent
threshold and a week still alerts — a worker that was running and stopped
is worth a week of notices. Once a day, because that is how often the cron
runs; with several orgs it posts once per org, which one agency with one org
does not need engineered around.

**A silent worker is a number in `/api/health`, not an inference.**
`worker_heartbeats` is a SYSTEM table with no `org_id` — the worker serves
every org — keyed `hostname:pid`, upserted every tick with `{ halted,
lockHeld, sms, intervalMs, version }` in its `detail` (`version` is null
under `node apps/agent/dist/index.js`, which is how the image runs; `sms` is
`'on'|'off'`, whether this worker carries DoveSoft, 0019 — no table change).
The row's `outreach` still means the MAILBOX, as it always has, and `sms` is
read beside it: `heartbeatSms` (`packages/db/src/heartbeat-read.ts`) takes
`detail.sms`, and `heartbeatReport` carries it as `sms: 'on'|'off'|null` —
null for no row and for a row that does not say, which is a worker from
before 0019, never read as off. `/api/health`'s `worker` block spreads the
report, so it carries `sms` too, and the dashboard, `/settings` and
`/compliance` word a worker that texts with its mailbox off as sending (§2,
"The settings pages and the dashboard"). `booted_at` moves on
a re-boot with the same id. Rows older than 30 days are pruned on every write,
BEFORE the upsert, so a write throws exactly when its row was not written —
which `lastHeartbeatAt()`, and so `/readyz`'s `heartbeatWrittenAt`, rely on.
A failed write is logged once per failure streak (and on a change of error
class) and once on recovery — not 5,760 identical lines a day while 0018 is
missing — and never stops the worker (§4: only liveness may stop a process).
What the row says comes from `healthInputs()`, the same object `/readyz`
answers from, so the two cannot disagree about the halt or the lock. On the
web side a row decides `live` or `silent` whatever the configuration says — an
observation beats configuration — `never` is a configured worker with no row,
and `not_configured` is neither; the one exception is the retired row above.
`/api/health`'s `worker.status` is `heartbeatReportedStatus`, which says
`retired` for it, beside `retired: true|false`. `retired` is not a fifth
value of `HeartbeatReport['status']`, which stays `silent`; every reader
words it through `workerWord` (`lib/dashboard-view.ts`), so the dashboard
("Worker retired — last seen …"), `/settings` and `/settings/deployment` say
`retired` too, as the digest does. `worker` never changes
`/api/health`'s status or code, even under `?strict=1`.

### Search, exports and records

**Search excludes connectors, secrets, prompts, chat, approval payloads, audit
detail, raw scans, users and provider ids (§2.3); `q` is content and stays out
of logs.** `GET /api/search` has no `search` capability: each section is gated
by the read capability that already gates its table (`searchSectionsFor`),
outbound bodies only for `approvals:decide` and reply bodies under
`campaigns:read`. `apps/web/test/search-source.test.ts` pins the exact
searched-column set, so adding a column is a visible §2.3 decision rather than
a quiet one. A driver error is logged by name only, because drizzle's message
quotes the bound parameters. A query is 2 to 100 characters after whitespace
is collapsed.

**Exports are audited because lead data left the database; a blank is not
false.** `GET /api/export/{companies,findings,consents}` each write one
`export.<view>` row `{ rows, filters }` BEFORE the file is produced, and answer
503 with nothing exported if that row cannot be written — stricter than the
house `.catch(() => {})`, because an unrecorded movement of lead data is the
very thing §2.3 and §5.5 care about. Over 20,000 rows is a 413, never a
truncated file. Every file is UTF-8 with a BOM, then `# internal — never
prospect-facing`, then RFC 4180 CRLF rows, with any cell starting `=`, `+`,
`-`, `@`, a tab or a CR prefixed by an apostrophe. `stale` is derived from
`ran_at` — the findings export's projection does not even carry
`findings.stale`. In the findings file `gap` AND `weight` are blank for an
unobserved signal, because a 0 is a number a spreadsheet sums; in the consents
file a missing row is `never_asked`. `/companies` is a GET form run through
`lib/company-list.ts`, and the companies export honours the same query string,
so "export this view" is exactly the rows on screen, and it pastes straight
back into `/companies/import`: `parseCompanySeeds` (`packages/db/src/csv.ts`)
spots an export by its header — a row of column names that includes
`domain` and `name` and more besides — reads it as RFC 4180, takes those two
columns and removes the formula guard's apostrophe from the name. Read the
old way, everything after the first comma was the name, and a NEW domain
came back named `Acme,72,A — call first`. A bare `domain,name` header or a
headerless list reads exactly as before. The one ambiguity left: a stored
name that really starts with an apostrophe followed by `=`, `+`, `-`, `@`, a
tab or a CR comes back without it.

**A person's whole record is one download, and erasure keeps the
suppression** — see the send path above.

### The settings pages and the dashboard

**`/settings` is five read-mostly pages.** `/settings/icp` shows the stored
definition with no editor (§4); a stored `stale_after_days` that is not a
positive number of days is named as refused, beside the default every
reader uses in its place (§1). `/settings/spend` reads only Postgres sums of
`chat_messages.cost_usd` — per UTC day and per person, revoked people
included — gated on `audit:read` like `/compliance`. `/settings/deployment`
names every variable and never shows a value or a URL that carries one, beside the heartbeat
and the schema state computed exactly as `/api/health` computes it; it is the
page that answers "why would nothing send?". Since 0019 it also prints the
two DoveSoft webhook URLs to register, built from `AUTH_URL` with
`<DOVESOFT_WEBHOOK_SECRET>` where the token goes, and says (`dovesoftFacts`)
to generate the secret with `openssl rand -hex 32` or percent-encode it,
that a GET push puts a text's number and words in the request log so POST is
the form to ask for, that texts are matched in every org with
`DOVESOFT_ORG_ID` only the home of a number no contact holds — it decides
nothing about one a contact does — that without it a STOP from such a
number is recorded nowhere and answered 500 so DoveSoft retries, "200 when
the push carried no message id, since its retry could not be told from a
new text" (review round 10; it said "answered 500" alone), and (review
round 6) that a number several contacts share is filed under the one
this system texted, with the
others held, or otherwise under nobody with every holder held; the hub's "What this
deployment can do" table has no DoveSoft row. `/settings/templates` is the
one settings page added since, and it writes (§2, "SMS through DoveSoft"). `/settings/mail` checks the WEB
app's `MAIL_FROM` domain — SPF, DMARC, and DKIM at the common selectors or
`?dkim=<one label>` — with TXT lookups made from the browser through
`/api/settings/mail-dns`, so a slow nameserver delays one panel rather than the
page. The worker's `MAIL_FROM` lives on its own host, and the page says it
cannot see it. A 1024-bit RSA DKIM key (Resend's and Google's default) passes
with a note, and only a shorter one is "weak"; an answer that could not be
read is "could not be checked", never "missing". The heartbeat's words on
`/settings` (`workerModes` and `sendingAnswer` in
`apps/web/src/app/settings/facts.ts`) say EMAIL where they mean the mailbox
— "email outreach off", "sending email, not reading a mailbox" — and name
SMS from the row's `sms`: "texts through DoveSoft" or "SMS off". A worker
with its mailbox off and DoveSoft on "sends approved SMS through DoveSoft"
(tone ok), where the page used to say it "sends nothing". A live sending
worker whose row says `sms: 'off'` no longer hears that every unsent message
"carries its reason on the message" (review round 4): the sender leaves a
due row on a channel it carries no provider for exactly as it was, with no
refusal code and no `scheduled_for`, and only its log says why. So
`sendingAnswer` says an EMAIL carries its reason, and that an approved SMS
waits with no reason on it until SMS is switched on where the worker runs
(`DOVESOFT_API_KEY` and `DOVESOFT_ENTITY_ID` on its host); a row from before
0019 (`sms` null) hears that a text MAY wait so. The tone stays ok — email
sends, and an agency that never switched SMS on has nothing waiting. With
`sms: 'on'` the old sentence stands.

**The sidebar names the organisation, on every page, from one place.** The
subtitle under "Agency OS" is `orgs.name`, read by `Shell`
(`apps/web/src/components/shell.tsx`) itself: it is an async server
component that awaits `orgIdentity(user.orgId)` from
`apps/web/src/lib/org-identity.ts` — `server-only`, wrapped in React
`cache()`, so the sidebar, the settings index and the proposal page share one
read per request — and it has no `orgName` prop, so no page can name the org
differently. It used to be a prop: the dashboard and the settings area
passed the org's name and most other pages the active ICP's label — the name
of a scoring profile — so the sidebar named a different thing depending on
the page. Sixteen copies of that label read went with it, and
`/contacts/import` and `/companies/import` read no ICP at all now: the label
was their only use of it, and `/companies/import` parsed it bare, so a
malformed profile could 500 that page. `app/settings/org.ts` is gone (the
settings index imports `orgIdentity` from `lib/`). No `'use client'` module
imports `Shell`. `apps/web/test/sidebar-org-name.test.ts` walks every
`<Shell` call under `apps/web/src` and fails on an `orgName` attribute, an
ICP-reading expression in any attribute, or an `orgLabel` left in a page,
with self-tests showing its tag scanner can fail. The booking page and the
buyer's `/p/[token]` have no sidebar and are untouched.

**The dashboard states the phases once and every bullet from a fact.** Its
headline says "Phases 0–6 are built", and that Phase 6 is deliberately not
switched on only while no call is on record in this database. The worker
line comes from the newest heartbeat. "Needs a look" is a row of counters —
failing compliance checks, unhandled replies, drafts and agent actions
awaiting approval, deals untouched past their stage's limit or past due,
overdue tasks, and stale, never-scanned and unreachable companies at the
ICP's own threshold — each linking to the filter that lists exactly its rows;
a zero whose recorder is absent reads "None recorded" and names what is
missing. The last ten audit lines are `sentenceFor`'s. "What this instance can
and cannot do" is chosen in `lib/dashboard-view.ts` from `deployment()` or
from an observation — the heartbeat, the newest `scan.cron_run`, calls on
record — so "stale companies are rescanned daily" is only said once a rescan
has actually run in the last 36 hours.

**A worker that sends texts is a worker that sends.** The heartbeat's
`outreach` is the mailbox, so with DoveSoft on and no SMTP the dashboard
read "Its outreach is switched off: nothing is sent" while texts went.
`WorkerStatusLike` carries `sms` now (optional, absent reads as null, so a
status built without it is still one), and every live case is worded from
both: the worker line reads "… · sending and receiving email · texts through
DoveSoft · chat on", or "SMS off" only where the mail words could be read as
covering texts; the live-worker bullet says it "sends approved SMS through
DoveSoft" beside whatever it says of email; a row from before 0019 gets the
mailbox's sentence alone. `workerSends` counts either, so the headline and
`/compliance`'s recorders no longer call an SMS-only worker "not sending".
The bullet that said "Nothing here can place a call or send a text — no code
path for either", false since 0019, is `no-calls` now: nothing here can
place a call, and a text is sent only by the worker, through DoveSoft, from
a registered template, once a person has approved it on `/approvals`. And
texts back are their own fact, `deployment().smsInbound` (§4, "`deployment()`
flags"): the inbound bullet appends "Texts a contact sends back, a STOP
included, arrive through DoveSoft's webhook" to its email sentences, an
SMS-only deployment gets `inbound-sms-only` ("Only texts can arrive here"),
and the quiet-feed and "needs a look" notes no longer say no reply can
arrive. They ask two questions, not one (review round 4): `emailRepliesArrive`
(a mailbox-reading worker, or the email webhook) and `textsArrive`
(`smsInbound`). A single `repliesArrive` that counted DoveSoft's webhook
took the "None recorded" caveat off the unhandled-replies counter and had
the feed say "replies still arrive" on a deployment no email reply can
reach. With only DoveSoft's webhook the counter keeps its caveat — "None
recorded: … and no inbound email webhook is configured, so no email reply
can arrive here; texts still do, through DoveSoft's webhook" — and
`quietFeedNote` says "… so no sends or email replies appear here; texts
still arrive, through DoveSoft's webhook". `apps/web/test/dashboard-view.test.ts` runs the
SMS shapes through `heartbeatReport`, and `worker-check.test.ts` runs the
`workerSilent`/`heartbeatReport` agreement grid over `sms` on, off and
absent.

## 3. Commands

```bash
npm install
npm run typecheck        # packages AND tests, strict
npx tsc --build          # compile packages to dist/ only
npm test                 # 6741 tests in 226 files: domain + migrations + invariants + seed + parity + agent + send path + pipeline + voice + the 0018 release + DoveSoft SMS (0019) + fifteen review rounds + the operator's tools
npx vitest run --maxWorkers=1 --minWorkers=1   # the same suite on a machine short of memory
npm run build            # packages, then the Next app

# database (needs DATABASE_URL)
npm run db:migrate            # apply pending
npm run db:migrate -- status  # what is applied
npm run db:migrate -- down 1  # revert one (a down that reaches 0018 is refused while any user has revoked access — see §4)
npm run db:migrate -- reset   # all the way down, then up (refuses in production)
npm run db:seed               # org + owner + ICP + 16 seed companies; idempotent

# scanning (Phase 1)
npm run scan                  # every company that has never been scanned
npm run scan -- --all         # re-scan everything
npm run scan -- rentman.io    # one domain
npm run scan -- --import f.csv  # import a domain,name CSV, then scan
# ...and on Vercel, once CRON_SECRET is set, the two daily crons. Run either by
# hand with the bearer — the dashboard's Run control may not carry it:
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/rescan   # never-scanned, then stale
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/digest   # Slack digest + worker-silent alert

# a local Postgres on a machine with neither Postgres nor Docker
npm run db:local              # PGlite behind a TCP socket; data in .pgdata/

# the agent (Phase 2). The API key is NOT the default path — see the credit
# note below. AGENT_USE_LOCAL_LOGIN authenticates against the Claude Code
# login and costs no credit, which is how the gates below were passed.
AGENT_USE_LOCAL_LOGIN=true npx tsx --env-file=.env apps/agent/src/index.ts
npm run smoke:agent              # the Phase 2 gate. SPENDS whatever the worker authenticates with.
npm run smoke:agent -- --draft   # ...and make it park a draft on a human
npm run smoke:agent -- --connector deepwiki   # the Phase 3 gate (§6's "no restart")
# When /readyz reports chat disabled, the smoke test names AGENT_USE_LOCAL_LOGIN=true
# first (development only, spends no credit) and ANTHROPIC_API_KEY second.

# production operations, all prompt-based so no connection string touches a
# file, an argument list or shell history (§2.3)
./tools/remote-setup.sh       # migrate + seed a remote database
./tools/remote-status.sh      # read-only schema facts, safe to paste — the migration list ("[x] 0019_messaging_templates_and_sms"), "0018 is applied" and "0019 is applied"
./tools/run-worker.sh         # run the worker here, against production, nothing exposed — builds the
                              # packages first, before any question is asked or saved answer read, with the
                              # lockfile's node_modules/.bin/tsc (and runs the worker with .bin/tsx), never npx;
                              # refuses with "Run npm ci" when either is missing. Sets WEB_PUBLIC_URL,
                              # UNSUBSCRIBE_SECRET (Enter keeps the saved one or sends no unsubscribe header;
                              # a new one only when `new` is typed and confirmed, on a Mac) and SLACK_WEBHOOK_URL,
                              # and on a Mac keeps it awake (caffeinate -is) and can keep its answers in the
                              # login Keychain, each value base64 on security's stdin, never its argv.
                              # CHAT is optional: an ngrok tunnel on the operator's static domain to the
                              # worker's API port, started from an EMPTY environment with --inspect=false,
                              # ON only once ngrok logs the tunnel started, stopped by a watcher when the
                              # worker exits; the Anthropic key and an AGENT_INTERNAL_TOKEN made onto the
                              # clipboard for Vercel (with AGENT_URL; a saved one can be `copy`'d again);
                              # with chat off the worker is handed no Anthropic key
./tools/run-worker.sh --reconfigure   # ask every question again
./tools/run-worker.sh --forget        # delete the saved answers
./tools/add-teammate.sh       # grant somebody access — or Settings → Team, in the browser
./tools/spend.sh              # what the API has actually cost: per day, per person, run rate
./tools/mail-dns.sh           # SPF/DKIM/DMARC records for a sending domain
./tools/dev-login.sh          # a local sign-in link without a mailbox

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

**`cp .env.example .env` boots all three processes**, and that is now checked
rather than assumed: parsing the file the way `node --env-file` does and
running each process's `loadEnv` over it found that the worker refused a blank
`UNSUBSCRIBE_SECRET=`, `WEB_PUBLIC_URL=` or `LLM_PROVIDER=`, and the voice
service a blank `VOICE_PUBLIC_URL=` or `VOICE_ORG_ID=`. Those lines were
commented out for that reason; all three processes now read a blank as unset
(§4), so they are live again, and `apps/agent/test/env-example.test.ts`
replays the file with every commented blank uncommented and boots the worker
and the voice service on it. And compose reads `.env` only to fill
`docker-compose.yml`'s `${…}` — a variable that file does not name never
reaches a container, which left every optional feature off under compose
while the operator believed it configured. So every optional variable the web
app, the worker and the voice service read is now named in its service block
as `NAME: ${NAME:-}` — the DoveSoft five included, `DOVESOFT_API_KEY`,
`DOVESOFT_ENTITY_ID` and `DOVESOFT_BASE_URL` on the worker and
`DOVESOFT_WEBHOOK_SECRET` and `DOVESOFT_ORG_ID` on the web — and
`apps/agent/test/compose-env.test.ts` checks that against their schemas and
boots all three services on what compose would hand them — except, each
with its reason in the compose file, `AGENT_USE_LOCAL_LOGIN` (development
only), `CLAUDE_CODE_PATH` (a host path), `APPROVAL_POLL_MS`/`APPROVAL_SWEEP_MS`
(tuning knobs; the schema's defaults), `VERCEL_ENV` (set by the platform)
and the voice service's `VOICE_MODEL`, which the schema declares and nothing
reads (the scripted policy is the whole conversation). The voice service now
gets the `LLM_*` it summarises calls with — `LLM_PROVIDER`, `LLM_MODEL`,
`OLLAMA_BASE_URL`, `OLLAMA_IS_LOCAL`, `LLM_ALLOW_REMOTE_LEAD_DATA`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — and `VOICE_HANDOFF_USER_EMAIL`;
they were not passed before. Nothing under compose calls the two cron
routes; drive them from the host's crontab with `curl` and the bearer.

**`next build` does not run in a git worktree whose `node_modules` is
symlinked into the main checkout** (how parallel work in this repo is set up):
Turbopack refuses "files outside of the workspace root". `cd apps/web && npx
next build --webpack` is the equivalent check there, with the same
server/client boundary rules. The main checkout and Vercel are unaffected.

**The suite's memory cost is per WORKER, and that is what falls over first.**
vitest forks a worker per CPU and `freshDb()` builds an embedded Postgres in
each one — and it does that in `beforeEach`, so every individual test gets a
new PGlite instance and replays all nineteen migrations. On a machine under
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
`apps/voice` alone from 9.8s to 4.4s. The suite has grown several times
over since: at 0019, after DoveSoft and twelve review rounds, it is 6,411
tests in 216 files, and the full single-worker run at `b83c693` took
1,567 s — every test green. (At 0018 it was 4,246 in 154 and took 1,088 s.)
With the operator's tools (2026-10-06) it is 6,741 tests in 226 files, and
the full run with two workers took 1,026 s, every test green.

`freshDb()` remains and `migrations.test.ts` and `schema-parity.test.ts`
still use it — a test about applying migrations cannot start from a database
that already has them.

The obvious risk is that shared state would leak between tests and the
failure would not look like a harness bug: it would look like the product
behaving strangely, intermittently, depending on file order. That is exactly
how a suite starts passing vacuously, so it has its own test rather than an
argument in a comment. `packages/db/test/harness.test.ts` writes a row named
`LEAKED FROM THE PREVIOUS TEST` in one test and asserts the next cannot see
it, checks the migrations really are applied — the NEWEST first, because a
snapshot built from older migrations would carry every earlier one: 0019's
`message_templates` and `touches.template_id`/`delivery_status`, then 0018's
`findings.scored` and 0017's `reply_kind` as further lines — and re-checks
the UTC pin the snapshot could have lost.

**PGlite's clock is millisecond-grained** — 108 of 200 back-to-back reads
shared a timestamp — so a test that asserts the order of rows stamped by
`now()` gives each row its own stated moment: the erasure test's suppression
history did not, its tiebreak was a random uuid, and its order assertion
failed in CI (`packages/db/test/erasure.test.ts`, `appendAuditAt`).

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

**Vercel's own builders take a different path through Next from every other
build.** They switch @vercel/next's new adapter on (`NEXT_ENABLE_ADAPTER=1`),
and with this app's `output: 'standalone'` its `onBuildComplete` opens an
`apps/web/.next/next-server.js.nft.json` the build never wrote, so every
remote build failed after its migration step — the release run that put
production on 0019 applied both migrations and then deployed nothing. A
`vercel build` run anywhere else takes the classic path and works. So the
Production workflow's remote path (`release` with no
`PRODUCTION_DATABASE_URL`) passes `--build-env NEXT_ENABLE_ADAPTER=0`
beside `AGENCY_MIGRATE_ON_BUILD=1`, and `deploy` builds on the runner and
uploads the prebuilt output (`tools/production.sh`); both then wait for
`/api/health?strict=1` to report the checkout's migration.

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
edge — the reverse proxy on a VPS, the WAF rule on Vercel (DEPLOYING.md, "The
public surface"). This was a deliberate trade against roster disclosure, which
is the worse failure.

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
So does `/settings/icp`, and there is no ICP editor, on purpose: a stored score
names the definition it was computed from, and editing that definition in
place would change what every old score claims to mean.

**The ICP is partly descriptive, and `/settings/icp` says which part.**
`scoreCompany` evaluates four disqualifiers (`unreachable`,
`is_security_vendor`, `has_security_team`, `no_public_product`); the seed's
`enterprise_scale` is checked by nothing, and the page marks it so
(`SCORER_DISQUALIFIERS` in `apps/web/src/lib/icp-view.ts`, pinned against
`scoring.ts`). The profile's outreach block — channels, `max_per_day`,
`auto_send` — is enforced by nothing either: the send path applies each
campaign's own channel, cap and quiet hours. The dashboard's Active ICP table
used to show the profile's channels and daily cap as if they were the
operative values; its headings now read "Channels it describes" and "Daily
cap it describes", and `ICP_OUTREACH_NOTE` under it says the send path
applies each campaign's own, with links to `/campaigns` and `/settings/icp`.

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
belongs at the edge, not in the app: the reverse proxy in front of a VPS, and
on Vercel — where there is no proxy you control, which this sentence predates
— the WAF rule DEPLOYING.md asks for.

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

**Settings → Team revokes access and never deletes anyone.** Revoking stamps
`users.revoked_at` and deletes that person's sessions in the same transaction;
restoring clears the stamp and keeps the role. Three statements enforce the
rules themselves, with no check beforehand to race: a revoked owner does not
count as an owner, the last live owner cannot be demoted or revoked, and
nobody can revoke themselves. On its own, though, the last-owner `EXISTS` is
write skew under READ COMMITTED: two owners revoking or demoting each other
at once both succeeded and left the org with no owner (reproduced on a
scratch Postgres 16 with the real `usersRevoke`/`usersSetRole`). So a revoke
and a demotion run in a transaction that first takes
`pg_advisory_xact_lock(hashtext('users.owners'), hashtext(orgId))` — keyed on
the org, because the two writes that race are on different rows. Grant,
promote and restore take no lock: adding an owner cannot leave none.
Revocation is checked in three places in
`auth.ts` — the request leg, the callback leg and the per-request `session`
callback, all through `memberMayAccess` — and in the worker's
`resolvePrincipal` on every turn. The session-callback check closes a race: a
magic link completed just before a revocation could otherwise create a 30-day
session just after it. That callback deletes the sessions and THROWS; returning
nothing is not a safe alternative, because next-auth then falls back to the raw
adapter session, `sessionToken` included.

**"Last signed in" is `users.email_verified`.** @auth/core 0.41.3 re-stamps it
on every completed magic link and at no other time. `users.updated_at` also
moves on every sign-in (the adapter's `updateUser` fires the trigger), so it
means nothing and the page never shows it. `verification_tokens` are never
listed, because they hold rows for strangers.

**The team page is not a roster oracle either.** `users_email_key` is global,
so granting an address another org holds gets one generic sentence — "That
address cannot be added here." — with the same 409 as a same-org repeat, and
the address is never logged. A revoked member asking for a sign-in link gets
the same response as a stranger; only the operator log's `reason`
(`access_revoked` / `not_a_member`) tells them apart. Granting sends no mail.

**Suppression audit rows were never written.** The suppression routes put the
normalised value in `audit_log.subject_id`, a uuid column, and the insert
failed silently behind `.catch(() => {})`. Now `subjectId` is null and the
value is in `detail`, built by `auditSuppressionAdded`/`auditSuppressionRemoved`
in `packages/db/src/audit.ts`, which `suppression-audit.test.ts` runs through
`appendAudit` against a real engine. Every suppression change before 0018 is
missing from the log, and `/audit` says so rather than implying the log is
complete. These rows are the one place the append-only log holds an address,
a number or a profile, and they outlive an erasure by design — the record of
who asked to be left alone must outlive the person's file, as the
suppression row does. The person's downloadable record includes them
(`suppressionAudit`, through `auditSuppressionHistory`), so the record's own
list of what it leaves out can say so truthfully.

**A cron rescans; it is not a scan button.** §1 used to end its
`findings.stale` paragraph with "there is still no scheduled rescan"; now there
is one, and REPO-BRIEF's "no scan button" still stands: nobody clicks
`/api/cron/rescan`, and a person still scans one company with `npm run scan --
<domain>`. **Its deadline is derived, not guessed.** `worstCaseScanMs =
homeTimeoutMs × 11 + pathTimeoutMs × 11 + 8 000` (TLS) — 162 s at the cron's
8 s / 6 s — because a redirect chain may spend a per-hop timeout eleven times.
A company is dispatched only when `elapsed + worstCaseScanMs <= budget`, with
the budget 300 s less a 60 s margin, shared across orgs. The first rule,
"stop dispatching after 240 s", could start a scan at 239 s that ran to about
400 s, and the platform would kill the function with the audit row unwritten.
`rescan.test.ts` reads `fetch.ts`, so the restated 11 and 8 000 cannot drift.
**And the per-hop timeouts do not bound a body that drips a byte inside each
inactivity window** — `get()` checks its deadline before each hop, not during
the read — so each scan is raced against its worst case; one that loses is
abandoned, records nothing, and stops the run, because its sockets cannot be
closed and a second scan beside it would be the overlap the design forbids.
**It never picks a `*.inbound` company**: that is the booking page's
placeholder named after a person, and scanning it would resolve somebody's
email address as a DNS name every night, for an "unreachable" row about a
company that does not exist. A refused host takes no batch slot, or it would
sit at the head of the queue taking one every night forever. **And each org
is CLAIMED before anything is selected** (`claimRescan`), because the
twenty-hour floor cannot see a scan not yet recorded: two overlapping
deliveries both read the queue before either committed, and every company
was scanned twice. The claim is one short transaction under
`pg_advisory_xact_lock(hashtext('cron.rescan'), hashtext(orgId))` that looks
for a live `scan.cron_started` audit row and writes one only if there is
none; the row carries its own `until`, the claimant's ceiling, and holds no
longer. A duplicate delivery reports the org as `{ skipped: 'claimed',
heldUntil }`, and `/audit` has a sentence for `scan.cron_started`. The
digest does the same for the same reason (`digestOnce`).

**A second stranger-facing write surface**, added with the booking page's
rules verbatim — a hashed token, bodies read as text and bounded, nothing
enumerable returned, the accept through the same `setProposalStatus` and
`setDealStage` a person uses, audited — and §2.2 governs the buyer page harder:
no score, no tier, no "stale". The only other stranger-facing write added is
the one-click unsubscribe, and all it writes is an opt-out — the one write a
stranger must always be able to make. (The cron and Resend routes are public
paths too, but each is authenticated by a secret, not by a session.)

**§8.4's single path has a human-shaped provider.** The alternative was a
second sender in a route, which is exactly what the rule forbids. The words are
revealed only after the rules pass, because a message a person could copy
before the rules ran is a message that can go after a refusal — and, for the
same reason, withheld again on a later read once the send path refuses them
past approval, the person is paused, or the hand-over is a day old — on
every screen, not only `/tasks`: the company page's Conversation panel and
the agent's `get_company_timeline` apply the same rule
(`linkedinThreadWithheld`), because a withheld message one click or one
question away is not withheld.

**A per-tool review that can only DISABLE, where §6 recommends wildcards that
ALLOW.** §2's gate section explains why the wildcard is refused; this is what
stands in its place. `connectorToolsSetDisabled` writes ONE key with
`jsonb_set` and does not re-disable the connector or clear `last_ok_at` the way
`updateConnector` does, because narrowing what a server may do is not a change
to where it points — re-disabling would punish an owner for making a live
connector safer. `disabledTools` is `.optional()` rather than `.default([])`:
`ConnectorConfig` is the zod OUTPUT type, so a default made the key required
in every config literal a caller builds; `disabledToolNames` applies the
default instead.

**On Postgres 18 an `ON DELETE RESTRICT` refusal is SQLSTATE 23001, not
23503.** Measured on PGlite 18.3, and Neon runs 18.6: RESTRICT raises
`restrict_violation` (23001), NO ACTION still raises 23503, and Postgres 16/17
report RESTRICT as 23503. `pg-errors.ts` therefore exports
`isRestrictViolation(err, name?)` for 23001 and `isReferencedRowRefusal(err,
name?)` for 23001 OR 23503; `credentials.ts` uses the second, scoped to the
one constraint it means (`HELD_BY_A_CONNECTOR`), and a source pin keeps the
literal codes out of every other `packages/db/src` module. Any new code that
maps a refused DELETE of a referenced row to a sentence calls
`isReferencedRowRefusal`. Every foreign key in the migrations names its ON
DELETE — 45 CASCADE, 10 RESTRICT, 23 SET NULL at 0019, and none NO ACTION.

**`deployment()` flags are configuration, never observation — and a flag
means the feature can actually run.** `inbound: 'webhook'` for Resend needs
BOTH `RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY`, because the route answers
503 without either and saying "webhook" about a route that refuses everything
is the claim the module exists to stop. And a configuration flag is never
worded as what happened: review round 3 found `/compliance`, the inbox's
notes, `/contacts`' reply note, the settings Replies fact and the inbox reply
route reading `deployment().worker` (`AGENT_URL`) as if it said whether
anything sends or reads replies — false on the documented production shape,
`AGENT_URL` unset with a worker on Fly. Where copy says what a worker DID,
it now reads the heartbeat, as the dashboard always had; elsewhere it says
"configured" and points at `/settings/deployment`. The DoveSoft facts follow
the same rule: `dovesoftFacts` says what the web half accepts, and that the
sending half lives on the worker's host, which the page cannot see. Texts a
contact sends back are a flag of their own, `smsInbound`
(`DOVESOFT_WEBHOOK_SECRET` set), not a third `inbound` value, because
everything said about `inbound` is about EMAIL — Message-IDs, addresses, a
mailbox; it is optional, so a `Deployment` literal from before 0019 reads
false. Before it, `noRepliesReadNote`, the dashboard's inbound bullet and
quiet-feed note, `/contacts`, `/inbox` and `/compliance` all said no reply
could reach this deployment while DoveSoft's webhook let texts, a STOP
included, in; each now words the SMS-only shape. So does the "Replies" fact
on `/settings` and `/settings/deployment` (`deploymentFacts` in
`apps/web/src/app/settings/facts.ts`, review round 4): with
`DOVESOFT_WEBHOOK_SECRET` set it is on, adds "Texts a contact sends back, a
STOP included, arrive through DoveSoft's webhook", words the rest as
"inbound email webhook" and "no email reply is read", and lists
`DOVESOFT_WEBHOOK_SECRET` among its variables; it read off and "no reply is
read" while the same page listed the URLs texts arrive at. The pure facts live in
`lib/deployment-facts.ts` and the `server-only` reader in `lib/deployment.ts`,
for a measured rule: **a module a test in `apps/web/test` imports carries no
`server-only` and no `@/` import, transitively.** That is why
`secret-compare.ts`, `slack-post.ts`, `deployment-facts.ts`, `resend-inbound.ts`
and the `notification.ts` beside each hooked route exist as separate files, and
why a route that cannot be imported is pinned by reading its source.

**All three processes read a BLANK environment value as unset.** zod refuses
`''` for `z.string().min(32).optional()` and for `.url().optional()`, and
`.env.example` documents each optional variable as a blank `NAME=` — so with
the plain shapes, `cp .env.example .env` stopped the whole app booting over
features nobody had turned on. In the web app `CRON_SECRET`,
`SLACK_WEBHOOK_URL`, `UNSUBSCRIBE_SECRET`, `RESEND_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `DOVESOFT_WEBHOOK_SECRET`, `DOVESOFT_ORG_ID` and
`INBOUND_WEBHOOK_SECRET` are wrapped in
`z.preprocess(blankIsUnset, …)`; a present short value is still refused. The
worker does the same for `UNSUBSCRIBE_SECRET`, `WEB_PUBLIC_URL`,
`SLACK_WEBHOOK_URL`, `LLM_PROVIDER`, `LLM_MODEL`, `AGENT_MODEL`,
`OLLAMA_BASE_URL`, the three `DOVESOFT_*` (a blank `DOVESOFT_BASE_URL` is
DoveSoft's own API) and
`OUTREACH_BOUNCE_PAUSE_PCT` — a blank threshold is its default, 5, never 0,
which would pause a campaign on its first bounce — and the voice service for
`VOICE_PUBLIC_URL`, `VOICE_ORG_ID`, `VOICE_HANDOFF_USER_EMAIL`,
`LLM_PROVIDER`, `LLM_MODEL` and `OLLAMA_BASE_URL` (§3). The Slack host
refinement is hoisted into a const so its schema entry sits on one line,
because `packages/db/test/deployment.test.ts` reads `env.ts` line by line
and took a multi-line entry for a REQUIRED variable.

**CI's table count is derived from the migrations**, every distinct `CREATE
TABLE` in the up files plus `schema_migrations` — 32 at 0019, which adds
`message_templates` (31 at 0018) — rather than written down, so a migration
that adds a table cannot fail the Postgres 16 job for a reason nobody reads.
The compose-config job carries `AGENT_INTERNAL_TOKEN`, without which compose
refuses to render the file it is checking. `worker_heartbeats` is the one
table with no `org_id`, listed under the migrations test's `SYSTEM_TABLES`
with the auth tables and its own conventions.

**Migration 0018 is not the master plan's SQL verbatim.** Review added block
(0) — `users` and `contacts` `UNIQUE (id, org_id)` and the same-org composite
keys (§1) — in place of per-column references that let a row in one org name a
person in another, and the answer trigger. `schema.ts` declares those columns
without `.references`, as it already did `scanId`.

**Reverting 0018 is refused while anybody's access is revoked.** 0018's down
drops `users.revoked_at`, and code from before 0018 has no notion of
revocation, so a rollback silently let every offboarded teammate request a
link and sign in again; the file's own header called that only "revocations
are lost". A shipped down file is never edited (§10), so the refusal lives in
the migrator: `DOWN_GUARDS` in `packages/db/src/migrator.ts`, keyed by the
version whose down does the damage, checked for the WHOLE revert list before
anything is reverted. A `down` that reaches 0018 while any user has
`revoked_at` set is refused with the count and nothing reverted, unless
`--restores-revoked-access` is passed, and then the CLI says so. A revert
that goes on to 0001 is exempt — it drops `users` itself — so `down all` and
`reset` are not refused.

**Migration 0019 adds and constrains; its down loses data, stated.**
Everything new is text + CHECK and nothing is newer than Postgres 15.
`touches_sms_and_whatsapp_name_a_template` is added `NOT VALID` — enforced
on every new and updated row, never re-checked against stored ones —
because nothing before 0019 could put an outbound SMS or WhatsApp row in a
sendable state, and a row that somehow exists is refused `no_template` by
`decideSend` the first time anything tries to send it. It binds only the
statuses the sender can still carry to a provider (`awaiting_approval`,
`approved`, `queued`, `sending`), and every move into one re-evaluates it;
`sent` is reached only through `sending`, so every message that went out
named its template on the way. **It does not bind `sent`, and the first
version did** — review round 4 found that a CHECK is evaluated on EVERY
later UPDATE of a row, `NOT VALID` or not, so reverting 0019 (which drops
`template_id`) and applying it again left every earlier SMS un-updatable:
its delivery report answered 500, its recipient could not be erased, and
its contact could not be deleted (ON DELETE SET NULL is an UPDATE) — 0018's
`connectors_name_is_not_agency` trap again. The down also SETTLES every SMS
or WhatsApp message that could still go out — `refused`/`no_template`, or
`failed` for one caught `sending` — with an `error` saying 0019 was
reverted, because no code before 0019 can send one and a re-apply would
otherwise leave it bound with no template.
`packages/db/test/migration-0019-revert.test.ts` drives the sequence. Both
halves were changed after 0019 was pushed to this branch and before it
reached any deployed database (the 0010 precedent).
`contacts_bounce_code_is_rfc3463` is in 0019 too, and added valid, because
its one writer has refused anything else since 0018. Reverting 0019 deletes every template and
every delivery report and unlinks every SMS from its template; inbound SMS
rows stay.

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

**A fourth allow-shaped knob sits on exactly the channel connectors now
travel** (§2, "The runtime is assembled"). The SDK types an http/sse
server's config with an optional `tools?: McpServerToolPolicy[]` carrying
`permission_policy: 'always_allow' | 'always_ask' | 'always_deny'` — "per-tool
permission policy carried on mcp_set_servers for remote servers" — and the
CLI turns `always_allow` into `alwaysAllowRules.mcpServerPolicy`, answered
before `canUseTool` is asked. Nothing here builds one (`BuiltMcpServer` has
no `tools`), and `handOverServers` in `runtime/open-query.ts` refuses any
config that carries the key rather than hand it over.

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
3. **Ring 1 — `canUseTool`.** Grants and allows at once whatever
   `runsWithoutApproval` (`packages/core/src/risk.ts`) says may run — reads,
   derived writes, and the agency's own INTERNAL writes — and raises an
   approval card for everything else. **Internal writes run at once by the
   operator's decision (2026-10-06)**: an agent that must ask before it adds a
   note, moves a deal or files a company cannot run the CRM, which is what
   chat is for. The line is §2.4's own, "anything that leaves the building",
   and is drawn by RULE, never by tier: `writes_internal_state` (20 tools,
   among them `pause_contact` and `add_suppression`, which only ever STOP
   outreach) runs at once; `leaves_the_building` (`queue_touch`,
   `enrol_contacts`), `reopens_outreach` (`resume_contact`),
   `connector_unreviewed` (every third-party tool) and `delegation` (medium,
   but the one place a prepaid budget runs away) keep their card. An internal
   write is granted single-use and audited `agent.tool_allow` with its real
   tier and rule, exactly as a read is, so it does not slip past the ledger.
   `risk.test.ts` pins the carded agency tools to exactly those three, so a
   tool added or reclassified later fails until somebody chooses its side;
   `gate.test.ts` drives the real classifier through the gate both ways, and
   fails seven ways if the decision is put back to `risk === 'low'`. The
   system prompt says the same, and its test pins both halves: a model told
   every change waits proposes instead of acting, and one not told what DOES
   wait claims to have sent what it only drafted. Ring 2 below is unchanged:
   its `'ask'` only routes a call to this callback, which is what decides.
   **It never returns `null`**: the SDK's own doc says a null
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

**And the heartbeat.** `boot/heartbeat.ts` is started after the lock, like the
sender, and what its row says is read through `healthInputs()`, so the row and
`/readyz` cannot disagree about the halt or the lock. `/readyz` always carries
`heartbeatWrittenAt` — null until a write has landed, an ISO instant after —
and the boot log prints `workerId` (`hostname:pid`), the key the row is keyed
by. A silent worker is now a number in `/api/health`, not an inference (§2,
"Notifications and the heartbeat").

### Threads are per person, and the page checks

`/chat` picks the person's newest unarchived thread, or creates one, and
redirects to `/chat/<id>`, so the URL always names the thread on screen. A
thread list sits beside the panel with New thread, Rename and Archive, and a
way to put an archived thread back. `chatReadOwnSession` puts org AND user in
the WHERE, so a teammate's thread, another org's thread and a made-up id all
get the same 404; the org-scoped `readChatSession` stays the worker's read,
because the worker re-checks the owner itself. **Archive is refused while
`running_turn_id IS NOT NULL`**, in the UPDATE's own WHERE: a running turn may
be holding an approval card open in that thread, and archiving would hide the
card. Archived threads are hidden, not deleted — opened by URL they are
read-only, with no composer. A blank title is refused rather than stored as
NULL, because `ensureChatSessionTitle` would overwrite a NULL with the next
message. `chatSessionCosts` sums `cost_usd` in Postgres and returns
Postgres's own text; no total is ever formed in JavaScript. All of this works
with no worker; only sending a turn needs one, and the panel says so by naming
`AGENT_URL` and `AGENT_INTERNAL_TOKEN` rather than blaming an API key.

### The prompt names the gate-side tools, and the seed shapes new databases only

**The system prompt stops guessing where the rules are.** It points the model
to `get_pipeline`/`update_deal`/`book_meeting` for deals; to `check_send` and
`get_consent` before drafting — "the rule, not your guess"; to
`get_evidence_changes` before it repeats an old finding and
`get_stale_companies` before it quotes anything. It says `classify_reply` may
set a reply's kind but may never mark an opt-out, and that a note from
`add_note` is never evidence — and is filed under the name of the person it
is helping, with the audit log recording that the agent wrote it. A test
fails if the prompt names a tool that is
not in `AGENCY_TOOL_NAMES`.

**Fourteen tools joined the nine**, and the seeded subagents were given the ones
their job needs: the qualifier `get_scan_history` and `get_evidence_changes`;
the researcher those two plus `get_consent`, `check_send`,
`get_company_timeline` and `search_crm`; the closer `check_send`,
`get_consent`, `get_replies`, `classify_reply`, `add_note` and `create_task`.
Each seeded prompt says when to run the tools it was given, and `seed.test.ts`
pins grants and prompts together. **The seed inserts `agent_defs` with `ON
CONFLICT (org_id, slug) DO NOTHING`, so a live database's subagents do NOT
pick these up** — "re-seeding updates grants" was proposed and dropped for
exactly that reason. Change them in Settings → Agents; the seed only shapes a
new database.

**The operator's tools reached the prompt and the seed on 2026-10-06.** The
prompt opens with how to work — "do it with the tools rather than describing
how they could", read, act, confirm, report, one change at a time with its
reason, because "every change runs only after a person approves its card" —
and has a section per group naming each tool and the limit it keeps: a new
contact has no consent, auto-send is an owner's, a text is drafted by a
person, nothing in the calendar invites anybody, there is no terminal, a
suppression is never undone, and what a connector returns is a lead to
check, never evidence. For a NEW database the seeded helpers were given the
operator tools their jobs need — the qualifier `get_stale_companies` and
`rescan_stale`; the researcher `list_contacts`, `get_proposal` and
`list_meetings`, reads only; the prospector `add_company` and
`import_companies`; the closer `list_contacts`, `list_campaigns`,
`enrol_contacts`, `list_drafts`, `generate_proposal` and `get_proposal` —
and the prospector's prompt no longer says no sourcing connector exists: a
subagent is granted agency tools only, so it works from the domains it is
given and asks the main chat to look companies up with a connector. A live
database keeps its rows.

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
only and say in their summary that nothing was sent. The same rule held the
0018 tools back until their tables had writers: the release's first commit
shipped them as stubs answering `invalid_state`, and `packages/tools/test/no-stubs.test.ts` now fails
if a stub marker, or the stubs' "not available in this revision", survives in
any shipped source.

And §6's **skill-upload UI** — see the skills section above for why. Everything
else in §6 and §7 ships.
