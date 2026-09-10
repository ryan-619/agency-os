# Agency OS — architecture, invariants, commands

Internal operating system for a small application-security agency. Read
[PROMPT.md](PROMPT.md) for the full build spec; this file is the working
summary a session should read first.

**Current state: Phases 0 (Foundation) and 1 (Data core) are complete. Phase 2 has not started.**

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

**Not yet enforced — Phase 1 (§8.3):** `findings.stale`. The column, its index
and the 14-day threshold (`freshness.stale_after_days` in the seeded ICP) all
exist, but **nothing writes `stale` yet** and there is no scheduled rescan.
Freshness is derivable today from `scans.ran_at`. Phase 4's draft generator
must not assume a finding is fresh because `stale = false` — every row has
`stale = false` because nothing has ever set it.
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
- *The `canUseTool` gate that blocks on this lands in Phase 2.* That code also
  owns the expiry rule: the schema deliberately does **not** forbid
  `status = 'approved'` with `decided_at > expires_at`, because a stale-tab
  approval should surface as a clean "this request expired" from the decision
  service, not as a constraint violation and a 500.
- **Never set `permissionMode: "bypassPermissions"`.**

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
```

Not yet created, because their phase has not arrived (§12 — do not scaffold all
seven phases at once): `packages/tools` (Phase 2), `apps/voice` (Phase 6, and
only after A2P 10DLC registration clears).

### packages/scanner
`fetch.ts` does the I/O; `extract.ts` is pure. That split is not cosmetic — it
is what lets the same recorded bytes be replayed through this engine and the
original Python one, which is how the port is proved correct. The list of paths
the scanner may request is a frozen constant in `types.ts`, not a parameter, so
no caller can widen it into something that probes for `.git` or an admin panel.

### What lands in `packages/core`, and when
| Phase | Domain rules |
|---|---|
| 0 ✅ | authorisation — `can(principal, capability)`, log redaction — `redact()` |
| 1 ✅ | the ICP definition, scoring, tiering, disqualifiers, the `observed` rule |
| 2 | risk classification for the approval gate (§5.4) |
| 4 | consent, suppression, quiet hours, daily caps — the one send path |

---

## 3. Commands

```bash
npm install
npm run typecheck        # packages AND tests, strict
npx tsc --build          # compile packages to dist/ only
npm test                 # 147 tests: domain + migrations + invariants + seed
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

# the parity harness — regenerate only when re-recording on purpose
npm run fixtures:capture      # re-record the seed domains' public surface
npm run fixtures:golden       # re-run the PYTHON engine over those recordings

# the whole stack
cp .env.example .env
# set AUTH_SECRET: openssl rand -base64 32
docker compose up --build -d   # -d, or the first command holds the terminal
docker compose run --rm migrate
docker compose run --rm seed
# app        http://localhost:3000
# magic links http://localhost:8025   (Mailpit — dev only, relays nothing)
```

`packages/core` and `packages/db` compile to `dist/` and are consumed as
JavaScript, so **run `npx tsc --build` after changing them** or the web app
will use stale output. TypeScript project references handle the ordering.

---

## 4. Decisions and deviations

Places where this repo departs from a literal reading of PROMPT.md, and why.
Flagged rather than hidden, per §13.

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

**The dashboard reads the stored ICP definition** rather than repeating §11's
numbers as literals. The threshold, channels and daily cap shown are whatever
the active `icp_profiles` row says. A dashboard displaying a threshold the
engine is not using is the same class of mistake as a finding nobody observed.

**`/api/health` is unauthenticated and hits the database.** Deliberate — an
orchestrator has to reach it — and it reports only `err.name`, never the driver
message that would carry the DSN. It is not rate limited, so sustained
anonymous traffic can occupy connections from the same pool the app uses;
`DATABASE_POOL_MAX` exists partly so that ceiling is tunable. Rate limiting
belongs with the reverse proxy in front of the VPS, not in the app.

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

**One deliberate divergence.** Python's public-path probe does
`except Exception: continue`, so a timeout, DNS failure or WAF block on
`/security` is indistinguishable from a clean 404 — both become "no trust
page". That is the exact case §2.2 forbids. Here a 404 still counts as absent,
because a 404 IS an observation, but silence from every candidate marks the
signal `observed = false`. §2 outranks port fidelity. Asserted explicitly in
`packages/scanner/test/extract.test.ts` rather than hidden.

If you re-record the fixtures, the goldens must be regenerated in the same
commit, and the diff should be read: a changed score means the site changed, or
the engine did.

## 6. SDK verification (PROMPT.md §13)

§13 asks for the SDK option names to be checked against the installed package's
own types and any drift noted here. Checked against
**`@anthropic-ai/claude-agent-sdk@0.3.263`**.

Provenance, since this cannot be re-checked from inside the repo: the SDK is
**not** a dependency here — it arrives in Phase 2 — so these were read from a
scratch install of that exact version (`sdk.d.ts`), not from `node_modules`.
Re-verify against the version you actually install before building on them.

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
- `pg-boss@12.30.0` (Phase 2): **no default export** (`import { PgBoss }`),
  `boss.work` handlers receive an **array** of jobs, and `createQueue()` is
  mandatory before `send`/`work`.

---

## 7. Standards (PROMPT.md §10)

- TypeScript strict, plus `noUncheckedIndexedAccess`. No surviving `any`.
- Zod at every boundary — env is validated at startup in both apps.
- Domain rules in `packages/core`, pure, unit-tested against edge cases.
- Every migration reversible. **Never edit a shipped migration** — the migrator
  will refuse to run, on either half of the pair.
- `npm run typecheck` covers the shipped packages *and* the test suite
  (`tsconfig.test.json`). The test suite is the stated proof of the §2
  invariants, so it belongs inside the type system.
- Structured JSON logging. Never log credentials or full message bodies.
- Conventional commits, small PRs, one phase per branch.
