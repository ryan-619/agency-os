# Agency OS

Internal operating system for a two-to-five person agency selling application
security and DevSecOps engagements. It runs the funnel end to end: find
companies, qualify them on evidence, reach out, hold the conversation, and
carry a deal to a signed client.

Single organisation. No billing, no signup, no marketing site. The spec asks
for self-hosting, so that lead data stays on the agency's own hardware; the
live instance runs on Vercel and Neon instead, a deliberate departure
[DEPLOYING.md](DEPLOYING.md) states rather than hides.

> **Phases 0–6 are built, and every Definition of Done is proved** —
> [CLAUDE.md](CLAUDE.md) says exactly what "proved" means for each, and what it
> does not. Phase 6 (inbound voice) is built and deliberately not switched on
> until A2P 10DLC registration clears. One further release, on migration 0018,
> added the operating layer around the pipeline: an inbox, notes and tasks, a
> consent ledger, compliance and audit pages, search and exports, settings,
> proposal share links, LinkedIn steps a person sends, bounce handling,
> one-click unsubscribe, a worker heartbeat, and a nightly rescan and Slack
> digest on Vercel. Then SMS through DoveSoft, on migration 0019: opt-in only,
> sent only as DLT-registered templates a person approves, with delivery
> reports and STOP replies read back. [PROMPT.md](PROMPT.md) is the full spec.

---

## Running it

Ten minutes, from nothing to a login.

**You need:** Docker with Compose v2. That is all — Postgres, the web app and
the agent worker all come from the compose file.

```bash
git clone <this repo> && cd agency-os
cp .env.example .env
```

Set three values in `.env` — compose refuses to start without the first two,
because a stack that half-starts is harder to diagnose than one that stops:

```bash
# a signing key for sessions
AUTH_SECRET=$(openssl rand -base64 32)

# proves a call to the agent worker came from the web app; both share it
AGENT_INTERNAL_TOKEN=$(openssl rand -base64 32)

# the only address that will be able to sign in
SEED_OWNER_EMAIL=you@youragency.com
```

Everything else in `.env.example` is optional and fails closed: unset or
blank, the feature behind it is off and the screens that need it say so.
`docker-compose.yml` names the optional variables each app reads, so a value
set in `.env` reaches its container; the few it deliberately does not pass
are listed there with the reason.

Then:

```bash
docker compose up --build -d       # db, mailpit, web, agent
docker compose run --rm migrate    # create the schema
docker compose run --rm seed       # create the org, you as owner, and the ICP
```

`-d` matters: without it the first command holds the terminal streaming logs and
you never reach the other two. Follow them with `docker compose logs -f web` if
you want the output. The app is up before `migrate` runs, so sign-in only starts
working after those two commands.

Open <http://localhost:3000>, enter the address you put in `SEED_OWNER_EMAIL`,
and click **Email me a sign-in link**.

The link is waiting in **Mailpit at <http://localhost:8025>** — in development
mail never leaves the machine. Click it and you land on the dashboard.

### What you should see

A dashboard reporting **16 companies** — the seed list from §11 — and **zero
findings**. That is correct and it is the point: nothing has been scanned, so
the system claims nothing. It will not invent a finding to fill a card.

To give it something to look at:

```bash
npm run scan
```

That reads each company's public surface, scores it against the active ICP, and
writes what it observed. Then **Companies** lists them by fit, and each company
page shows every finding beside the evidence that produced it — the header that
was checked, the URL fetched, the library version served. On Vercel a nightly
cron does the same for never-scanned and stale companies once `CRON_SECRET` is
set; nothing under compose schedules it — drive it from the host's crontab
with `curl` and the bearer, as `docker-compose.yml` shows.

---

## Working on it

```bash
npm install
npm run typecheck     # packages and tests, strict
npm test              # 5243 tests, no Docker required
npx vitest run --maxWorkers=1 --minWorkers=1   # the same, on a machine short of memory
```

The test suite runs against [PGlite](https://pglite.dev), an embedded Postgres,
so migrations and domain rules are exercised with **no database server and no
Docker**. CI additionally runs the same migrations against a real
`postgres:16-alpine`, because PGlite tracks a newer Postgres major and is a
looser gate than the deploy target.

To run the app on your host against the compose database, change `DATABASE_URL`
in `.env` to `@localhost:5432` and:

```bash
ln -s ../../.env apps/web/.env   # once — Next reads .env from its own project dir
npm run db:migrate && npm run db:seed
npm run dev
```

The symlink is the whole story: the database scripts read the repo-root `.env`,
but Next only looks in `apps/web`, and its CLI re-execs through `NODE_OPTIONS`,
which rejects `--env-file`. One file, linked, rather than two that drift.
`.gitignore` covers `.env` at any depth, so the link is not committed.

### Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js 16 App Router — UI, BFF routes, Auth.js magic link, two Vercel crons |
| `apps/agent` | the long-running worker — agent turns over the Agent SDK, the send tick (email over SMTP, SMS through DoveSoft), IMAP reply detection, recovery, a heartbeat |
| `apps/voice` | inbound voice over Twilio ConversationRelay — built, not switched on |
| `packages/core` | domain logic — pure, no I/O, no framework, no database |
| `packages/scanner` | the public-surface collector, and the port of the Python engine |
| `packages/db` | schema, reversible SQL migrations (`0001`–`0019`), typed queries, seed |
| `packages/tools` | the agent's twenty-three typed tools, as plain data |
| `packages/llm` | the single-shot model clients behind §5.5's seam — optional; lead data stays local by default |

### Migrations

Hand-written, reversible, numbered pairs in `packages/db/migrations`:

```bash
npm run db:migrate               # apply pending
npm run db:migrate -- status     # what is applied
npm run db:migrate -- down 1     # revert one
npm run db:migrate -- down all   # revert everything
npm run db:migrate -- reset      # down all, then up (refuses in production)
```

Every `.up.sql` has a matching `.down.sql` — the migrator refuses to load one
without the other. It records a checksum over **both halves** of each applied
migration and **will not run if a shipped migration has been edited**, in
either direction. Add a new migration instead. A `down` that would revert
0018 is refused while any user has revoked access — 0018's down drops
`users.revoked_at`, which would let them sign in again — unless you pass
`--restores-revoked-access`.

---

## The rules this system will not bend

Four constraints shape almost every design decision. They are summarised here
because a new engineer will hit them within a day; the full statements are in
[PROMPT.md §2](PROMPT.md) and the enforcement is catalogued in
[CLAUDE.md §1](CLAUDE.md).

**It never claims a finding it did not observe.** Every finding row carries
`observed`, and four database constraints stand behind it: a finding cannot
claim it observed anything on a scan that failed, a claimed gap must carry the
evidence that produced it, and a finding cannot be filed against a company its
scan never touched. These claims go into an email under a real person's name;
a false one costs the deal.

**Cold outreach is email and LinkedIn. Never voice, never SMS.** Not caution
for its own sake — the FCC classified AI-generated voice as an "artificial
voice" under the TCPA in February 2024, which means prior express written
consent before dialling, with statutory damages of $500–$1,500 per call,
uncapped. Voice and SMS are for inbound contacts and recorded opt-ins. The
schema refuses to store a campaign that would breach this.

**Anything leaving the building needs a human**, unless a team member has
explicitly enabled auto-send for that specific campaign.

**No credential is ever written to a source file, a log line, or an agent's
context window.** Including the magic-link URL, which is a bearer credential.
The loggers redact known-sensitive keys as a backstop, but the rule is not to
pass credentials to a logger in the first place.

## Scanning: what it actually does

The scanner reads only what a company publishes to the open
internet — the response headers of their own homepage, its HTML, the
conventional public paths `/.well-known/security.txt`, `/security` and
`/trust`, and the TLS certificate their server presents.

There is no port scanning, no directory brute-forcing, and no probing for
`.git`, `.env`, backups or admin panels. Requesting a homepage and reading its
headers is what every browser does.

**This is posture review from the outside, not a security test.** Describe it
that way to a prospect. Never imply otherwise.

The list of paths it may request is a frozen constant, not a parameter, so no
caller can widen it.

### It is a port, and the port is checked

The engine is a translation of a Python original. Rather than trusting the
translation, `npm test` replays recorded captures of all sixteen seed domains
through **both** engines and asserts they agree — on every signal, the score,
the tier, the ordering, and the evidence. See [CLAUDE.md](CLAUDE.md) §5 for the
three real bugs that caught, and the one place the port deliberately disagrees
with its original in order to obey §2.2.

---

## Licence

Private. Internal tooling.
